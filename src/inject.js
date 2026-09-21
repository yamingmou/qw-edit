/**
 * qw-edit userscript v9 — 在 QwenWork 渲染进程主世界运行。
 *
 * 架构（遮蔽方案，借鉴 dsh-retrace 的 surface 遮蔽思想）：
 *   模型上下文 = CLI 会话转录（jsonl）。撤回不动原转录（审计轨迹保留），
 *   而是让客户端"看到"一个截断视图：
 *     1. daemon 新建遮蔽文件 <newSessionId>.jsonl（原文件截断到锚点行）
 *     2. chats.rollbackToMessage 截断消息投影（UI 同步）
 *     3. chats.updateSubChatSession 重指会话到 newSessionId
 *   下次提交时客户端检测 runtime 不可复用 + 转录文件存在 → resume 遮蔽文件
 *   → 模型上下文 = 截断后内容（真失忆）。
 *   顺序关键：投影先截断再重指，保证投影 ⊆ 转录，避免触发客户端的
 *   "transcript truncated → 注入缺失历史"补偿路径。
 *
 * 操作原语（全部走客户端内部 tRPC / desktopApi）：
 *   chats.listSidebar / get / listBySubChat   定位消息
 *   chats.getSubChat                           读取会话状态（sessionId / streamId）
 *   agent.cancelStream / agent.cancel          忙时护栏：停止进行中的回答（降级链）
 *   chats.rollbackToMessage                    截断消息投影（官方原语）
 *   chats.updateSubChatSession                 重指会话（官方原语）
 *   agent.submitMessage                        发送消息
 *
 * 安全纪律（学自 dsh-retrace host-core）：
 *   - 每个操作返回 {ok, error:{code}} 信封，绝不静默半失败
 *   - 同一会话同时只允许一个回退操作（锁）
 *   - agent 忙时自动停止并等待收尾（agent-busy）
 *   - 目标会话与当前可见对话交叉验证（DOM 锚定，防误伤）
 *   - 遮蔽文件必须通过验证（锚点定位成功 + 被撤回文本不在场）才继续
 *   - 原文件永不修改/删除（append-only 审计轨迹）
 */
(() => {
  if (window.__qwEdit) return; // 防重复注入
  const log = (...a) => console.log("%c[qw-edit]", "color:#e06c75", ...a);
  const bridge = window.electronTRPC;
  if (!bridge) { log("no electronTRPC global, skip"); return; }

  /* ---------- 1. 极简 trpc-electron 客户端 ---------- */
  let nextId = Math.floor(Math.random() * 1e6) + 100;
  const pending = new Map();
  bridge.onMessage((msg) => {
    try { handleResponse(msg); } catch {}
  });
  function handleResponse(msg) {
    const id = msg?.id ?? msg?.operation?.id ?? msg?.payload?.id;
    const entry = pending.get(id);
    if (!entry) return;
    let data = msg?.result?.result?.data ?? msg?.result?.data ?? msg?.payload?.result?.data ?? msg?.data;
    if (data === undefined && msg?.result?.result) data = msg.result.result;
    // superjson 反序列化：响应 data 为 {json: <真实数据>, meta?: ...} 包装
    if (data && typeof data === "object" && !Array.isArray(data) && "json" in data
        && Object.keys(data).every((k) => k === "json" || k === "meta")) data = data.json;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (msg?.error ?? msg?.result?.error) entry.rej(new Error(JSON.stringify(msg.error ?? msg.result.error)));
    else entry.res(data);
  }
  function trpc(type, path, input) {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${path} timeout`)); }, 30000);
      pending.set(id, { res, rej, timer });
      // superjson：带参请求 input 需 {json: input} 包装
      const wireInput = input === undefined ? undefined : { json: input };
      bridge.sendMessage({ method: "request", operation: { id, type, path, input: wireInput } });
    });
  }
  const q = (path, input) => trpc("query", path, input);
  const m = (path, input) => trpc("mutation", path, input);

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  function extractText(x) {
    const parts = x?.parts ?? x?.content ?? [];
    if (typeof parts === "string") return parts;
    if (Array.isArray(parts)) return parts.map((p) => (p?.type === "text" ? p?.text : "")).join("");
    return "";
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 2. 操作信封 + 会话锁（dsh-retrace 纪律） ---------- */
  function opErr(code, message, details) {
    const e = new Error(message);
    e.code = code; e.details = details;
    return e;
  }
  const opLocks = new Map(); // subChatId -> promise 链
  function withLock(subChatId, fn) {
    const prev = opLocks.get(subChatId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    opLocks.set(subChatId, next);
    void next.finally(() => { if (opLocks.get(subChatId) === next) opLocks.delete(subChatId); }).catch(() => {});
    return next;
  }

  /* ---------- 3. 忙时护栏：ensureIdle（自动停止并等收尾） ---------- */
  async function subChatState(subChatId) {
    const raw = await q("chats.getSubChat", { id: subChatId });
    return raw?.json ?? raw;
  }
  async function ensureIdle(subChatId) {
    let sd = await subChatState(subChatId);
    if (!sd?.streamId) return;
    log("stream in progress, cancelling…");
    // 停止原语降级链（Windows v1.1.52 实测：chats.cancelStream 不存在，
    // 可用的是 agent.cancelStream / agent.cancel；逐个尝试，全失败才报错）
    let stopped = false, lastErr = null;
    for (const p of ["agent.cancelStream", "agent.cancel", "chats.cancelStream"]) {
      try { const r = await m(p, { subChatId }); log("stop via", p, "->", JSON.stringify(r)); stopped = true; break; }
      catch (e) { lastErr = e; }
    }
    if (!stopped) throw opErr("agent-stop-failed", "停止进行中的回答失败：" + (lastErr?.message || "未知错误"));
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      sd = await subChatState(subChatId);
      if (!sd?.streamId) return;
    }
    throw opErr("agent-busy", "回答仍在生成，请先点击停止后重试");
  }

  /* ---------- 4. 跨会话定位消息 + DOM 锚定（防误伤） ---------- */
  async function chatDetail(chatId) {
    let det = await q("chats.get", { id: chatId });
    det = det?.json ?? det;
    const subs = det?.subChats ?? det?.chat?.subChats ?? [];
    return {
      chat: det?.chat ?? det,
      subs: [...subs].sort((a, b) =>
        (b.updatedAt ?? b.createdAt ?? 0).toString().localeCompare((a.updatedAt ?? a.createdAt ?? 0).toString())),
    };
  }
  async function loadMessages(subChatId) {
    const data = await q("chats.listBySubChat", { subChatId, limit: 200 });
    const list = Array.isArray(data) ? data : (data?.messages ?? []);
    return list.map((x) => ({
      subChatId,
      messageId: x.id,
      sdkMessageUuid: x.metadata?.sdkMessageUuid ?? undefined,
      // 助手消息在转录里占多行（不同行 uuid）；官方 getForkPointCandidates 同时吃复数与单数
      sdkMessageUuids: Array.isArray(x.metadata?.sdkMessageUuids) ? x.metadata.sdkMessageUuids : [],
      status: x.metadata?.status ?? x.metadata?.taskStatus ?? undefined,
      sequence: x.sequence,
      role: x.role,
      text: extractText(x),
      createdAt: x.createdAt ?? undefined,
    }));
  }
  async function findMessages(text, { role = "user", mode = "exact", limitChats = 10, limitSubs = 3 } = {}) {
    let chats = await q("chats.listSidebar");
    chats = Array.isArray(chats) ? chats : (chats?.json ?? chats?.chats ?? []);
    const t = norm(text);
    if (!t) return [];
    const prefix = t.slice(0, 30);
    const results = [];
    for (const c of chats.slice(0, limitChats)) {
      try {
        const { chat, subs } = await chatDetail(c.id);
        for (const s of subs.slice(0, limitSubs)) {
          let msgs;
          try { msgs = await loadMessages(s.id); } catch { continue; }
          for (const msg of msgs) {
            if (msg.role !== role) continue;
            const st = norm(msg.text);
            if (!st) continue;
            const hit = mode === "exact" ? st === t : st.startsWith(prefix);
            if (hit) results.push({ msg, all: msgs, chat, sub: s });
          }
        }
      } catch {}
    }
    return results;
  }
  /* DOM 锚定：候选会话的消息文本必须大量出现在当前可见对话里，才允许对它动手。
   * 防误伤：按钮在会话 A 的视图里点击，匹配却命中会话 B 时，拒绝执行。 */
  function visibleKeys() {
    const keys = new Set();
    const sel = 'div[class*="container/user-message"] div[class*="whitespace-pre-wrap"],' +
                'div[class*="container/assistant-message"] div[class*="whitespace-pre-wrap"],' +
                'div[class*="container/assistant-message"] p';
    for (const el of document.querySelectorAll(sel)) {
      const k = norm(el.textContent).slice(0, 20);
      if (k) keys.add(k);
    }
    return keys;
  }
  /* 文本一致性：编辑=精确相等；重新生成=30 字前缀互容（渲染与转录可能略有差异） */
  function textConsistent(a, b, mode) {
    a = norm(a); b = norm(b);
    if (!a || !b) return false;
    if (mode === "exact") return a === b;
    a = a.slice(0, 30); b = b.slice(0, 30);
    return a === b || a.startsWith(b) || b.startsWith(a);
  }
  function bubbleTextOf(el, role) {
    return role === "user" ? bubblePureText(el) : (el.textContent || "");
  }
  function bubbleSelector(role) {
    return role === "user" ? 'div[class*="container/user-message"]' : 'div[class*="container/assistant-message"]';
  }
  /* 同文本气泡内的相对序数：该气泡之前、内容与期望一致的同类气泡数。
   * 相比全局气泡序数，不受「列表外的气泡」（流式中/未提交/虚拟化截断）干扰。 */
  function bubbleOrdinalAmong(container, role, expectText, mode) {
    const all = [...document.querySelectorAll(bubbleSelector(role))];
    let rel = -1;
    for (const el of all) {
      if (!textConsistent(bubbleTextOf(el, role), expectText, mode)) continue;
      rel++;
      if (el === container) return rel;
    }
    return rel;
  }
  /* 定位消息：**先按文本圈定候选，再用序数在候选中定位**（而不是拿全局 DOM 序数
   * 直接索引消息列表）。这样即使 DOM 里存在列表外的气泡（流式中 / 未提交 / 截断），
   * 或列表未完全加载，也能正确落到同一文本的第 N 条，根治「气泡与消息序数对不上」。 */
  function pickByOrdinal(hits, role, ordinal, expectText, mode = "exact", relOrdinal = -1) {
    const pinned = pinHits(hits);
    if (!pinned) return null;
    const sameRole = pinned.all.filter((x) => x.role === role).sort((a, b) => a.sequence - b.sequence);
    const t = norm(expectText);
    if (!t) return null;
    // 文本候选：先按内容圈定（编辑=精确，重新生成=前缀），再在候选中定位
    const cands = sameRole.filter((x) => textConsistent(x.text, t, mode));
    if (!cands.length) return null; // 文本完全对不上 → 非当前会话/列表未覆盖，交调用方提示
    // 路径 1（最常见）：全局序数直接命中且文本一致 → 直接用，最少计算
    const direct = sameRole[ordinal];
    if (direct && textConsistent(direct.text, t, mode)) return { ...pinned, msg: direct };
    // 路径 2：全局序数错位（DOM 存在列表外气泡）→ 用「同文本相对序数」在候选中定位。
    // relOrdinal 是点击瞬间同步快照（数字），不依赖 await 后可能失联的 DOM 引用。
    const rel = relOrdinal >= 0 ? relOrdinal : ordinal;
    if (rel >= 0 && rel < cands.length) return { ...pinned, msg: cands[rel] };
    // 兜底：相对序数越界（被点的可能是流式中/未提交气泡，或列表被截断）→ 宁停不错
    throw opErr("ordinal-mismatch", "气泡与消息序数对不上（可能仍在生成或列表未加载），请稍后重试");
  }
  function bubbleOrdinal(container, selector) {
    const all = [...document.querySelectorAll(selector)];
    return all.indexOf(container);
  }
  function pinHits(hits) {
    const vis = visibleKeys();
    if (!vis.size) return null;
    let best = null, bestScore = 0;
    for (const h of hits) {
      let score = 0;
      for (const mm of h.all) {
        const k = norm(mm.text).slice(0, 20);
        if (k && vis.has(k)) score++;
      }
      if (score > bestScore) { bestScore = score; best = h; }
    }
    if (!best) return null;
    const minScore = best.all.length >= 2 ? 2 : 1;
    return bestScore >= minScore ? best : null;
  }
  function anchorBefore(msgs, seq) {
    // 回退锚点：目标之前最近的助手消息（需带 sdkMessageUuid，优先 status=completed）
    const cands = msgs.filter((x) => x.role === "assistant" && x.sdkMessageUuid && x.sequence < seq);
    return cands.filter((x) => x.status === "completed").sort((a, b) => b.sequence - a.sequence)[0]
        ?? cands.sort((a, b) => b.sequence - a.sequence)[0] ?? null;
  }

  /* ---------- 5. daemon 操作通道（page → daemon，经 CDP 轮询） ---------- */
  const opQueue = [];
  const opResolvers = new Map();
  window.__qwEditTakePendingOp = () => opQueue.shift() ?? null;
  window.__qwEditResolveOp = (r) => {
    const fn = opResolvers.get(r?.id);
    if (fn) { opResolvers.delete(r?.id); fn(r); }
  };
  function daemonOp(req) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { opResolvers.delete(id); resolve({ ok: false, error: "op-timeout" }); }, 10000);
      opResolvers.set(id, (r) => { clearTimeout(timer); resolve(r); });
      opQueue.push({ id, ...req });
    });
  }

  /* ---------- 6. 核心：trueRollback（遮蔽方案，原地不动会话） ---------- */
  /* 返回 {lines, originalLines}；任何失败都抛带 code 的错误。
   * 顺序：先投影截断前的验证（遮蔽文件建好且验证过），再截断投影，最后重指。
   * - 遮蔽失败 → 零影响，中止
   * - 投影截断失败 → 遮蔽文件成惰性孤儿（无害），会话未重指，中止
   * - 重指失败 → 模型上下文未变（runtime 仍为旧会话），如实报错可重试 */
  async function trueRollback({ subChatId, anchor, all, forbiddenTexts, stopBeforeTime }) {
    await ensureIdle(subChatId);
    const src = await subChatState(subChatId);
    const originalSessionId = src?.sessionId ?? undefined;
    if (!originalSessionId) throw opErr("no-session", "该会话没有可回退的上下文");

    // 锚点序数：投影中该锚点之前的助手消息数（含自身）= 转录中第 N 组 assistant 行
    const anchorOrdinal = all.filter((x) => x.role === "assistant" && x.sequence <= anchor.sequence).length;

    // 1. 遮蔽文件：截断到锚点（daemon 只新增文件，不改原文件）+ 验证
    //    stopBeforeUserText = 被撤回的用户提问：daemon 据此在转录里定位截断点
    //    （「回退到这次提问之前」），不受投影合并转录组的影响；
    //    stopBeforeTime = 提问发送时间：提问未落盘时（客户端重启丢轮）的时间戳回退
    const newSessionId = crypto.randomUUID();
    const r = await daemonOp({
      kind: "shadow", sessionId: originalSessionId, newSessionId,
      anchorOrdinal, anchorText: anchor.text, anchorMessageId: anchor.messageId,
      stopBeforeUserText: forbiddenTexts?.[0],
      stopBeforeTime,
      forbidden: forbiddenTexts,
    });
    log("shadow ->", r);
    if (!r?.ok) {
      throw opErr("shadow-failed", "上下文截断失败，已中止（会话未受影响）：" + (r?.error || "") +
        (r?.violations ? "（仍含被撤回内容：" + r.violations.join("、") + "）" : ""));
    }

    // 2. 截断投影（UI 同步；必须在重指之前——保证投影 ⊆ 转录，
    //    否则客户端 resume 时会检测"转录缺失"并把被撤回内容作为历史注入）
    const rb = await m("chats.rollbackToMessage", { subChatId, sdkMessageUuid: anchor.sdkMessageUuid });
    log("rollback ->", rb);
    if (rb && rb.success === false) throw opErr("rollback-failed", "回退失败: " + (rb.error || "未知错误"));

    // 3. 重指会话（下次提交 resume 遮蔽文件 → 模型失忆）
    await m("chats.updateSubChatSession", { id: subChatId, sessionId: newSessionId });
    log("session repointed ->", newSessionId);
    return { lines: r.lines, originalLines: r.originalLines, newSessionId };
  }

  /* ---------- 7. 首轮兜底（无锚点）：重建 subChat（投影清零 + 全新上下文） ---------- */
  async function firstTurnReinit({ chatId, sub }) {
    // 删除唯一 subChat（投影清空），在原 chat 下新建（继承 mode/modelLevel）
    await m("chats.deleteSubChat", { id: sub.id });
    const created = await m("chats.createSubChat", {
      chatId,
      mode: sub?.mode ?? "agent",
      ...(sub?.modelLevel ? { modelLevel: sub.modelLevel } : {}),
    });
    const c = created?.json ?? created;
    const newId = c?.id ?? c?.subChatId ?? (typeof c === "string" ? c : null);
    if (!newId) throw opErr("create-failed", "重建会话失败：" + JSON.stringify(created).slice(0, 150));
    log("subChat re-init:", sub.id, "->", newId);
    return newId;
  }
  /* 视图刷新（无重载）：我们的 tRPC 提交对渲染层是"身外之事"（官方流程中乐观
   * 更新与流订阅都由渲染层自己发起），提交后需让视图重新拉取。
   * 做法：点击侧边栏中该会话条目 → React 重新挂载视图并 refetch。
   * 绝不用 location.reload / openMainWindowWithChat（会整页重载，实测重载后
   * 立即执行 tRPC 查询会让渲染进程假死）。找不到条目则提示手动切换。 */
  function sidebarItemsByName(chatName) {
    if (!chatName) return [];
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (!t || !(t === chatName || t.includes(chatName))) continue;
      const btn = node.parentElement?.closest("li")?.querySelector("button");
      if (btn && !out.includes(btn)) out.push(btn);
    }
    return out;
  }
  function sidebarFirstOtherItem(chatName) {
    const items = [...document.querySelectorAll("li button")];
    for (const btn of items) {
      const t = (btn.textContent || "").trim();
      // 侧边栏会话条目：短文本、非当前会话、非功能区按钮
      if (t && t.length < 30 && !t.includes(chatName) && !/新任务|⌘|扩展|技能|连接器|定时|网页|频道|项目|反馈/.test(t)) return btn;
    }
    return null;
  }
  /* 无重载视图刷新：点走 → 点回。React Query staleTime=0，组件重新挂载即 refetch。
   * 会话名实时从 listSidebar 取（自动标题会改写会话名，创建时的名字会失效）；
   * 点走目标也从列表取真实会话（避免误点功能区按钮）。URL ?chat= 校验落点。 */
  async function rebindView(chatId, chatNameHint) {
    let chats = await q("chats.listSidebar");
    chats = Array.isArray(chats) ? chats : (chats?.json ?? chats?.chats ?? []);
    const me = chats.find((c) => c.id === chatId);
    const myName = me?.name ?? chatNameHint;
    // 1. 点走（任一其他真实会话，让目标视图卸载）
    const other = chats.find((c) => c.id !== chatId);
    if (other && sidebarItemsByName(other.name).length) {
      sidebarItemsByName(other.name)[0].click();
      await sleep(700);
    }
    // 2. 点回（当前实时名字优先，旧名兜底）；URL 落对后还要等消息真正渲染
    const rendered = async () =>
      document.querySelectorAll('div[class*="container/user-message"],div[class*="container/assistant-message"]').length > 0
      || document.querySelector("textarea:not([readonly]), [contenteditable='true']"); // 空会话也算就绪
    for (const name of [myName, chatNameHint].filter(Boolean)) {
      for (const btn of sidebarItemsByName(name)) {
        btn.click();
        await sleep(700);
        if (!location.search.includes(chatId)) continue;
        // URL 已落对：等视图渲染完成（最多 6s），期间内容可能仍在加载
        for (let i = 0; i < 12; i++) {
          if (await rendered()) { log("rebindView ok:", name); return true; }
          await sleep(500);
        }
        log("rebindView: url ok but view not rendered yet");
        return true; // 落点正确，渲染交给时间
      }
    }
    toast("[qw-edit] 新回答已生成，请点击左侧对应会话名查看", "warn");
    return false;
  }
  /* 回答完成（streamId 清空）后再刷新一次，确保最终答案可见 */
  function rebindAfterCompletion(chatId, chatName, subChatId, maxSec = 180) {
    void (async () => {
      for (let i = 0; i < maxSec; i++) {
        await sleep(1000);
        try { const sd = await subChatState(subChatId); if (!sd?.streamId) break; } catch { break; }
      }
      await rebindView(chatId, chatName);
    })();
  }
  function chatCwd(chat) {
    return chat?.worktreePath ?? chat?.project?.path ?? "";
  }

  /* ---------- 8. UI：toast + 按钮 ---------- */
  function toast(msg, kind = "ok") {
    const colors = { ok: "rgba(34,197,94,.95)", warn: "rgba(234,179,8,.95)", err: "rgba(239,68,68,.95)" };
    const el = document.createElement("div");
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed", bottom: "28px", left: "50%", transform: "translateX(-50%)",
      zIndex: 99999, background: colors[kind] || colors.ok, color: "#fff",
      padding: "8px 16px", borderRadius: "8px", fontSize: "13px", maxWidth: "70vw",
      boxShadow: "0 4px 14px rgba(0,0,0,.3)", pointerEvents: "none",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  /* ---- 自定义弹窗（替代浏览器原生 confirm/prompt，Windows 原生窗太丑） ---- */
  function escHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  let modalBusy = false;
  function uiConfirm({ title, body, confirmText = "继续", cancelText = "取消", danger = true } = {}) {
    return new Promise((resolve) => {
      if (modalBusy) { resolve(false); return; } // 理论不会发生（调用方 await 串行）
      modalBusy = true;
      let done = false;
      const close = (val) => {
        if (done) return; done = true;
        ov.remove(); document.removeEventListener("keydown", onKey); modalBusy = false; resolve(val);
      };
      const ov = document.createElement("div");
      ov.className = "qw-modal-overlay";
      ov.innerHTML = `
        <div class="qw-modal" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
          <div class="qw-modal-title">${escHtml(title)}</div>
          <div class="qw-modal-body">${escHtml(body)}</div>
          <div class="qw-modal-actions">
            <button class="qw-modal-btn qw-modal-cancel" data-act="cancel">${escHtml(cancelText)}</button>
            <button class="qw-modal-btn ${danger ? "qw-modal-danger" : "qw-modal-primary"}" data-act="ok">${escHtml(confirmText)}</button>
          </div>
        </div>`;
      // Enter 交给按钮原生行为（OK 默认聚焦 → Enter 即确认）；文档级只拦 Escape，
      // 避免焦点在「取消」按钮上按 Enter 被文档级监听抢先当成确认。
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(false); } };
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(false); });
      ov.querySelector('[data-act="cancel"]').onclick = () => close(false);
      ov.querySelector('[data-act="ok"]').onclick = () => close(true);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(ov);
      ov.querySelector('[data-act="ok"]').focus();
    });
  }
  /* 回退成功但找不到输入框时的兜底：展示原文 + 一键复制（替代原生 prompt） */
  function uiPrompt(text) {
    return new Promise((resolve) => {
      if (modalBusy) { resolve(); return; }
      modalBusy = true;
      let done = false;
      const close = () => {
        if (done) return; done = true;
        ov.remove(); document.removeEventListener("keydown", onKey); modalBusy = false; resolve();
      };
      const ov = document.createElement("div");
      ov.className = "qw-modal-overlay";
      ov.innerHTML = `
        <div class="qw-modal" role="dialog" aria-modal="true">
          <div class="qw-modal-title">已回退，请复制原文粘贴重发</div>
          <textarea class="qw-modal-text" readonly spellcheck="false"></textarea>
          <div class="qw-modal-actions">
            <button class="qw-modal-btn qw-modal-cancel" data-act="close">关闭</button>
            <button class="qw-modal-btn qw-modal-primary" data-act="copy">复制原文</button>
          </div>
        </div>`;
      const ta = ov.querySelector(".qw-modal-text");
      ta.value = text;
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("已复制原文，可粘贴到输入框");
        } catch {
          ta.focus(); ta.select();
          try { document.execCommand("copy"); toast("已复制原文"); }
          catch { toast("请手动复制下方原文", "warn"); }
        }
      };
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
      ov.querySelector('[data-act="close"]').onclick = close;
      ov.querySelector('[data-act="copy"]').onclick = () => { void copy(); close(); };
      document.addEventListener("keydown", onKey);
      document.body.appendChild(ov);
      ta.focus(); ta.select();
    });
  }
  const BTN_EDIT = "qw-edit-btn";
  const BTN_REGEN = "qw-regen-btn";
  const BTN_REGEN_END = "qw-regen-end-btn";
  const style = document.createElement("style");
  style.textContent = `
    .${BTN_EDIT}, .${BTN_REGEN}{position:absolute;right:6px;top:6px;z-index:9999;cursor:pointer;
      display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:6px;color:#fff;
      font-size:11px;line-height:1;border:none;box-shadow:0 1px 4px rgba(0,0,0,.35);
      opacity:0;transition:opacity .15s}
    .${BTN_EDIT}{background:rgba(59,130,246,.92)}
    .${BTN_REGEN}{background:rgba(139,92,246,.92)}
    /* 回退用浮动图标（官方行未渲染时）：消息右下角的小圆图标 */
    .${BTN_REGEN_END}{position:absolute;right:8px;bottom:8px;z-index:9999;
      width:28px;height:28px;display:flex;align-items:center;justify-content:center;
      border-radius:8px;color:#fff;border:none;box-shadow:0 1px 4px rgba(0,0,0,.35);
      background:rgba(139,92,246,.92);opacity:0;transition:opacity .15s;cursor:pointer}
    .qw-user-msg:hover>.${BTN_EDIT}, .qw-assist-msg:hover>.${BTN_REGEN}, .qw-assist-msg:hover>.${BTN_REGEN_END}{opacity:1}
    .qw-msg-time{display:block;margin-top:4px;line-height:1.4}
    /* 自定义确认弹窗（替代浏览器原生 confirm，Windows 原生窗太丑） */
    .qw-modal-overlay{position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);animation:qwFade .15s ease}
    .qw-modal{width:min(440px,90vw);background:#232329;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:20px 22px;box-shadow:0 16px 48px rgba(0,0,0,.55);color:#ececf0;font-size:13px;line-height:1.65;animation:qwPop .18s ease}
    .qw-modal-title{font-size:15px;font-weight:600;margin-bottom:10px;color:#fff}
    .qw-modal-body{color:#b9b9c4;white-space:pre-wrap;word-break:break-word;max-height:44vh;overflow:auto}
    .qw-modal-text{width:100%;min-height:120px;max-height:40vh;resize:vertical;margin-top:4px;background:rgba(0,0,0,.25);color:#e8e8ec;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;font-size:13px;line-height:1.5;font-family:inherit}
    .qw-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
    .qw-modal-btn{padding:7px 18px;border-radius:8px;border:none;font-size:13px;line-height:1.4;cursor:pointer;color:#fff;transition:background .12s}
    .qw-modal-btn:focus-visible{outline:2px solid rgba(139,92,246,.85);outline-offset:2px}
    .qw-modal-cancel{background:rgba(255,255,255,.14)}
    .qw-modal-cancel:hover{background:rgba(255,255,255,.22)}
    .qw-modal-primary{background:rgba(139,92,246,.95)}
    .qw-modal-primary:hover{background:#7c51f0}
    .qw-modal-danger{background:rgba(239,68,68,.95)}
    .qw-modal-danger:hover{background:#e33b3b}
    @keyframes qwFade{from{opacity:0}to{opacity:1}}
    @keyframes qwPop{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
  `;
  document.head.appendChild(style);
  function makeButton(cls, label, title, onClick) {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.title = title;
    btn.onclick = (ev) => { ev.stopPropagation(); onClick(btn, ev.currentTarget.closest(".qw-user-msg,.qw-assist-msg") || undefined); };
    return btn;
  }
  function mountButton(container, cls, label, title, onClick) {
    if (container.querySelector("." + cls)) return;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(makeButton(cls, label, title, onClick));
  }
  /* 输出下方官方按钮行的「重新生成」：贴进那一行（复制/满意/不满意 同一行）末尾，
   * 做成同款 icon 按钮（↻ 字形 + 克隆兄弟按钮样式，与官方融为一体）。
   * 返回 true=已入行；false=该行不存在（如流式中），调用方回退到浮动图标。 */
  function mountRegenRow(el) {
    const stray = el.querySelector("." + BTN_REGEN_END);
    if (el.querySelector('[data-qw-regen="1"]')) { if (stray) stray.remove(); return true; }
    const ref0 = el.querySelector('button[aria-label="满意"], button[aria-label="复制文本"], button[aria-label="不满意"]');
    const row = ref0?.closest("div.flex.items-center");
    if (!row) return false;
    if (stray) stray.remove(); // 官方行已出现，移除浮动回退，避免重复
    const ref = row.querySelector("button");
    const wrap = document.createElement("span");
    wrap.className = "block";
    const btn = document.createElement("button");
    if (ref) btn.className = ref.className; else btn.className = BTN_REGEN_END;
    btn.setAttribute("aria-label", "重新生成");
    btn.title = "重新生成";
    btn.dataset.qwRegen = "1";
    btn.innerHTML = '<span style="font-size:15px;line-height:1">↻</span>';
    btn.onclick = (ev) => { ev.stopPropagation(); onRegen(btn, el); };
    row.appendChild(wrap); wrap.appendChild(btn);
    return true;
  }
  /* 回退用：消息末尾的浮动重新生成（官方行还没渲染时，如流式中） */
  function mountRegenEnd(container) {
    if (container.querySelector("." + BTN_REGEN_END)) return;
    const btn = document.createElement("button");
    btn.className = BTN_REGEN_END;
    btn.innerHTML = '<span style="font-size:15px;line-height:1">↻</span>';
    btn.title = "重新生成";
    btn.onclick = (ev) => { ev.stopPropagation(); onRegen(btn, container); };
    container.appendChild(btn);
  }
  function fail(e) {
    const code = e?.code || "internal";
    log("op failed:", code, e.message);
    toast(`[qw-edit] ${e.message}`, "err");
  }
  function linesMsg(r) {
    return r?.lines != null ? `（上下文 ${r.originalLines} → ${r.lines} 行，已验证）` : "";
  }

  /* ---- 编辑重发（用户消息）---- */
  function bubblePureText(el) {
    const pure = el.querySelector('div[class*="whitespace-pre-wrap"]');
    return (pure ?? el).textContent || "";
  }
  async function waitComposer(timeout = 6000) {
    for (let i = 0; i < timeout / 200; i++) {
      const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']");
      if (el) return el;
      await sleep(200);
    }
    return null;
  }
  async function onEdit(btn, bubble) {
    const _html = btn.innerHTML; // 保存原始内容，结束时原样恢复（修文字标签丢失 bug）
    btn.disabled = true; btn.textContent = "…";
    try {
      const ordinal = bubbleOrdinal(bubble, 'div[class*="container/user-message"]');
      // 同文本相对序数在点击瞬间同步快照（await 期间 React 可能重渲染使 bubble 失联）
      const relOrdinal = bubbleOrdinalAmong(bubble, "user", bubblePureText(bubble), "exact");
      const hits = await findMessages(bubblePureText(bubble), { role: "user", mode: "exact" });
      const hit = pickByOrdinal(hits, "user", ordinal, bubblePureText(bubble), "exact", relOrdinal);
      if (!hit) throw opErr("cannot-confirm-target", "无法确认这条消息属于当前会话：请切换到其他会话再切回来后重试");
      const { msg, all, chat, sub } = hit;
      const anchor = anchorBefore(all, msg.sequence);
      if (anchor) {
        // 二次确认：回退是破坏性操作（锚点之后的内容从会话移除），防误点
        if (!(await uiConfirm({ title: "编辑重发", body: "将回退到这条消息之前：\n它之后的所有消息（含回答）会从本会话移除（磁盘原文件保留作审计），原输入会放回输入框供你修改重发。\n\n继续？", confirmText: "回退并编辑" }))) return;
        btn.textContent = "…";
        const r = await withLock(sub.id, () =>
          trueRollback({ subChatId: sub.id, anchor, all, forbiddenTexts: [msg.text], stopBeforeTime: msg.createdAt }));
        // rollback 自带 broadcastChatMessagesInvalidated，UI 会自行刷新，无需重绑
        await waitComposer();
        await fillComposer(msg.text);
        toast("已回退到该消息之前" + linesMsg(r) + "，修改后直接发送");
      } else {
        // 首条消息：无锚点 → 重建 subChat（投影清零，全新上下文，原消息保留在历史聊天里）
        if (!(await uiConfirm({ title: "编辑重发", body: "这是会话的第一条消息，将清空本会话并回填原文（编辑后直接发送）。\n\n继续？", confirmText: "重置会话" }))) return;
        btn.textContent = "…";
        const newSub = await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        await rebindView(chat.id, chat.name || ""); // 重建 subChat 无广播 → 点走点回重新挂载（无重载）
        await waitComposer();
        await fillComposer(msg.text);
        toast("已重置会话，原文已回填，修改后直接发送");
      }
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false; btn.innerHTML = _html;
    }
  }

  /* ---- 重新生成（助手消息）---- */
  /* 重新生成 = 用户输入 → 整条重来一次：不管原回答好坏/完整/中断，
   * 不做回答侧任何维度计算（序数/前缀/完整度），只取该回答前紧邻的用户提问并原样重发。 */
  function prevUserBubble(bubble) {
    let prev = null;
    for (const u of document.querySelectorAll('div[class*="container/user-message"]')) {
      if (u.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING) prev = u;
      else break; // 已到达 bubble 之后，后续都不是"前面"的
    }
    return prev;
  }
  async function onRegen(btn, bubble) {
    const _html = btn.innerHTML; // 保存原始内容，结束时原样恢复（修文字标签丢失 bug）
    btn.disabled = true; btn.textContent = "…";
    try {
      // 语义定稿（用户）：重新生成 = 直接按提问重新输出整条回答，**不做消息维度计算**——
      // 不跨会话搜索、不数全局序数/同文相对序数、不算前缀互容、不算完整度。
      // 1. 取该回答前紧邻的用户提问（DOM 直接读取，天然精确，非计数）
      const userBubble = prevUserBubble(bubble);
      if (!userBubble) throw opErr("no-prompt", "这条回答之前没有提问，无法重新生成");
      const promptText = bubblePureText(userBubble);
      if (!norm(promptText)) throw opErr("no-prompt", "这条回答之前没有提问，无法重新生成");
      // 2. 当前会话（URL chatId → 当前子会话），不跨会话搜索
      const chatId = new URLSearchParams(location.search).get("chat");
      if (!chatId) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
      const { chat, subs } = await chatDetail(chatId);
      const sub = subs[0];
      if (!sub) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
      const all = await loadMessages(sub.id);
      // 3. 本会话内按文本定位提问：同文多条取最后一条（对应最近一次提问；无计数）
      const same = all.filter((x) => x.role === "user" && norm(x.text) === norm(promptText));
      const userMsg = same[same.length - 1];
      if (!userMsg) throw opErr("cannot-locate-prompt", "无法定位这条回答对应的提问（列表未加载完整），请稍后重试");
      const anchor = anchorBefore(all, userMsg.sequence);
      let targetSub = sub.id, targetChat = chat.id;
      if (anchor) {
        // 二次确认：回退 + 自动重发是破坏性操作（锚点之后的内容从会话移除），防误点
        if (!(await uiConfirm({ title: "重新生成", body: "将回退到该回答之前并重新生成：\n该回答及之后的内容会从本会话移除（磁盘原文件保留作审计），并用原提问自动重新发送（消耗一次模型调用）。\n\n继续？", confirmText: "回退并重新生成" }))) return;
        btn.textContent = "…";
        // forbidden 只放被撤回轮的用户消息文本。锚点回答必须保留在遮蔽文件里，
        // 不加入 forbidden（锚点与被撤回回答文本相同时会误拦）
        const r = await withLock(sub.id, () =>
          trueRollback({ subChatId: sub.id, anchor, all, forbiddenTexts: [userMsg.text], stopBeforeTime: userMsg.createdAt }));
        btn.textContent = "…";
        await sleep(600);
        toast("已回退" + linesMsg(r) + "，重新生成中…");
      } else {
        // 第一组对话：无锚点 → 重建 subChat + 自动重发
        if (!(await uiConfirm({ title: "重新生成", body: "这是会话的第一组对话，将重置会话并用原提问重新生成（消耗一次模型调用）。\n\n继续？", confirmText: "重置并重新生成" }))) return;
        btn.textContent = "…";
        targetSub = await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        await sleep(300);
        await rebindView(chat.id, chat.name || ""); // 新 subChat 无广播 → 点走点回挂载新视图（仅此一次）
      }
      // 用原提问重新发送：优先走官方输入框（渲染层自己发起提交 → 流式与最终回答
      // 原生可见，无需「点走点回」重绑，页面不再跳动；runtime resume 遮蔽文件 →
      // 上下文为截断后内容）
      const sent = await sendViaComposer(userMsg.text, targetSub, targetChat);
      if (!sent) {
        // 兜底：官方路径未确认提交（Enter 未触发 / 视图不在目标会话等）→
        // tRPC 直提 + 视图重绑（旧路径；提交对渲染层不可见，需点走点回）
        const input = {
          subChatId: targetSub,
          chatId: targetChat,
          prompt: userMsg.text,
          cwd: chatCwd(chat),
          historyEnabled: true, // 必须：否则助手消息不带 sdkMessageUuid，后续锚点全部失效
        };
        if (sub?.mode) input.mode = sub.mode;
        const r = await m("agent.submitMessage", input);
        log("resubmit ->", r);
        await sleep(800);
        await rebindView(chat.id, chat.name || "");
        rebindAfterCompletion(chat.id, chat.name || "", targetSub);
      }
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false; btn.innerHTML = _html;
    }
  }

  async function fillComposer(text) {
    const composer = document.querySelector("textarea:not([readonly]), [contenteditable='true']");
    if (!composer) { await uiPrompt(text); return; }
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      composer.textContent = "";
      document.execCommand("insertText", false, text);
    }
  }

  /* 官方输入框发送：回填文本 + 派发 Enter，让渲染层自己发起提交。
   * 优点：乐观更新、流式、最终回答全部原生可见，无需 rebindView（页面不跳动）。
   * 返回 true=已确认提交（目标 subChat 出现 streamId）；false=未确认（调用方走 tRPC 兜底）。 */
  async function sendViaComposer(text, subChatId, expectedChatId, timeoutMs = 5000) {
    try {
      // 护栏：当前视图必须是目标会话（防确认/回退期间用户切走导致发错会话）
      if (expectedChatId && new URLSearchParams(location.search).get("chat") !== expectedChatId) return false;
      const sd0 = await subChatState(subChatId);
      if (sd0?.streamId) return false; // 已有流在跑，不走此路径
      const composer = await waitComposer();
      if (!composer) return false;
      await fillComposer(text);
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
      // 验证：官方提交会立刻在目标 subChat 上建立 streamId
      for (let i = 0; i < timeoutMs / 250; i++) {
        await sleep(250);
        const sd = await subChatState(subChatId).catch(() => null);
        if (sd?.streamId) return true;
      }
      // Enter 没触发提交（可能只插入了换行）：清残留文本，交兜底路径
      try { await fillComposer(""); } catch {}
      return false;
    } catch { return false; }
  }

  /* ---- 消息时间展示（AI 输出补时间；用户消息官方已有同款小灰字，保持不动） ---- */
  function fmtTime(iso) {
    if (iso == null) return "";
    // 防御：接口若返回秒级 epoch（10 位）会被 new Date 误当毫秒（1970 年），统一按秒×1000
    const d = typeof iso === "number" && iso < 1e12 ? new Date(iso * 1000) : new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  let timeState = { chatId: null, subId: null, list: null, bubbles: 0, lastReloadAt: 0, untagged: 0 };
  async function mountTimes() {
    const chatId = new URLSearchParams(location.search).get("chat");
    if (!chatId) return;
    const bubbles = [...document.querySelectorAll('div[class*="container/assistant-message"]')];
    if (timeState.chatId !== chatId) timeState = { chatId, subId: null, list: null, bubbles: 0, lastReloadAt: 0, untagged: 0 };
    if (!timeState.subId) {
      try {
        const det = await chatDetail(chatId);
        // 竞态护栏：await 期间用户可能已切走会话，状态被重置为新 chatId；
        // 此时若写入旧 chat 的 subId 会污染新会话（时间错配）。校验后丢弃。
        if (timeState.chatId !== chatId) return;
        const subs = det.subs ?? [];
        // 当前激活子会话：优先 updatedAt 最新；与按钮共用 loadMessages，无需额外 API
        timeState.subId = subs[0]?.id ?? null;
      } catch { return; }
      if (!timeState.subId) return;
    }
    const subId = timeState.subId; // 快照：await 期间 subId 可能被重置，须用它校验
    // 重拉条件：无列表 / 气泡数变化（新消息、回退、滚动加载）/
    // 存在未被列表覆盖的未打标气泡且列表已陈旧 ≥5s（流式完成后的补拉，避免每 1.5s 一轮 tRPC）
    const now = Date.now();
    const staleUntagged = timeState.untagged > 0 && now - timeState.lastReloadAt > 5000;
    if (!timeState.list || timeState.bubbles !== bubbles.length || staleUntagged) {
      try {
        const list = await loadMessages(subId);
        // 竞态护栏（与 subId 同款）：await 期间用户可能已切走会话或切换子会话，
        // 此时写入旧列表会覆盖新会话状态 → 校验后丢弃。
        if (timeState.chatId !== chatId || timeState.subId !== subId) return;
        timeState.list = list;
        timeState.lastReloadAt = now;
      } catch { return; }
      timeState.bubbles = bubbles.length;
    }
    const assists = timeState.list.filter((m) => m.role === "assistant")
      .sort((a, b) => a.sequence - b.sequence);
    // 对齐校验：subs[0] 只是"updatedAt 最新"，若用户正查看的是其它子会话，
    // 列表与可见对话会毫无文本交集 → 宁缺勿错，本轮不写时间（避免把别的会话的时间打过来）。
    const vis = visibleKeys();
    if (vis.size && timeState.list.length) {
      let hit = 0;
      for (const m of timeState.list) {
        const k = norm(m.text).slice(0, 20);
        if (k && vis.has(k)) { hit++; break; }
      }
      if (!hit) { timeState.untagged = 0; return; }
    }
    let untagged = 0;
    bubbles.forEach((b, i) => {
      if (b.querySelector("[data-qw-time]")) return;
      const msg = assists[i];
      if (!msg) {
        // 列表未覆盖：流式中（未提交，稍后可补拉）或长会话列表被截断（补拉无用）。
        // 仅当列表未满 200 条（说明是流式中而非截断）才标记补拉，避免长会话无限轮询。
        if (timeState.list.length < 200) untagged++;
        return;
      }
      const t = msg?.createdAt ? fmtTime(msg.createdAt) : "";
      if (!t) return; // 无 createdAt（老消息/个别类型）：数据本身没有，重拉也补不上，不计数
      const layer1 = b.querySelector(':scope > div[class*="px-"]');
      const col = layer1?.querySelector(":scope > div.flex.min-w-0.flex-col") || layer1;
      if (!col) return;
      const span = document.createElement("span");
      span.className = "qw-msg-time text-xs text-text-quaternary";
      span.dataset.qwTime = "1";
      span.textContent = t;
      const toolRow = col.querySelector("div.flex.h-6");
      if (toolRow) col.insertBefore(span, toolRow);
      else col.appendChild(span);
    });
    timeState.untagged = untagged;
  }

  function mountButtons() {
    for (const b of document.querySelectorAll('div[class*="container/user-message"]')) {
      b.classList.add("qw-user-msg");
      mountButton(b, BTN_EDIT, "✎ 编辑重发", "编辑重发", onEdit);
    }
    for (const b of document.querySelectorAll('div[class*="container/assistant-message"]')) {
      b.classList.add("qw-assist-msg");
      mountButton(b, BTN_REGEN, "↻ 重新生成", "重新生成", onRegen); // 顶部保留（文字，方便发现）
      // 底部：贴进输出下方官方按钮行做 icon；该行未渲染时回退到末尾浮动 icon
      if (!mountRegenRow(b)) mountRegenEnd(b);
    }
  }

  /* ---------- 9. 调试入口 & 启动 ---------- */
  window.__qwEdit = {
    trpc, findMessages, loadMessages, chatDetail, fillComposer,
    trueRollback, ensureIdle, subChatState, pinHits, daemonOp, toast,
    uiConfirm, uiPrompt, sendViaComposer,
    firstTurnReinit, rebindView, sidebarItemsByName,
  };
  setInterval(() => { mountButtons(); void mountTimes(); }, 1500);
  log("v9.12 loaded (edit/regen + times + composer-send + prompt/time-anchored shadow). 调试入口: window.__qwEdit");
})();
