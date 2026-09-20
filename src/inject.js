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
 *   chats.cancelStream                         忙时护栏：停止进行中的回答
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
    try { await m("chats.cancelStream", { subChatId }); } catch (e) { throw opErr("agent-stop-failed", "停止进行中的回答失败：" + e.message); }
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
  /* 序数定位：点击的第 N 个同角色气泡 = 投影中第 N 条同角色消息。
   * 解决重复文本（如多轮"好的。"）导致 findMessages 前缀匹配错选的问题。
   * 以文本一致性校验兜底：不匹配则报错（宁停不错）。 */
  function pickByOrdinal(hits, role, ordinal, expectText, mode = "exact") {
    const pinned = pinHits(hits);
    if (!pinned) return null;
    const sameRole = pinned.all.filter((x) => x.role === role).sort((a, b) => a.sequence - b.sequence);
    const msg = sameRole[ordinal];
    if (!msg) return null;
    // 一致性校验（用户消息精确匹配；助手消息前缀匹配）
    const a = norm(mode === "exact" ? expectText : expectText.slice(0, 30));
    const b = norm(mode === "exact" ? msg.text : msg.text.slice(0, 30));
    if (a && b && a !== b && !a.startsWith(b) && !b.startsWith(a)) {
      const e = opErr("ordinal-mismatch", "气泡与消息序数对不上（列表可能未完全加载），请刷新后重试");
      e.badPick = true;
      throw e;
    }
    return { ...pinned, msg };
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
  async function trueRollback({ subChatId, anchor, all, forbiddenTexts }) {
    await ensureIdle(subChatId);
    const src = await subChatState(subChatId);
    const originalSessionId = src?.sessionId ?? undefined;
    if (!originalSessionId) throw opErr("no-session", "该会话没有可回退的上下文");

    // 锚点序数：投影中该锚点之前的助手消息数（含自身）= 转录中第 N 组 assistant 行
    const anchorOrdinal = all.filter((x) => x.role === "assistant" && x.sequence <= anchor.sequence).length;

    // 1. 遮蔽文件：截断到锚点（daemon 只新增文件，不改原文件）+ 验证
    const newSessionId = crypto.randomUUID();
    const r = await daemonOp({
      kind: "shadow", sessionId: originalSessionId, newSessionId,
      anchorOrdinal, anchorText: anchor.text,
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
      const hits = await findMessages(bubblePureText(bubble), { role: "user", mode: "exact" });
      const hit = pickByOrdinal(hits, "user", ordinal, bubblePureText(bubble));
      if (!hit) throw opErr("cannot-confirm-target", "无法确认这条消息属于当前会话：请切换到其他会话再切回来后重试");
      const { msg, all, chat, sub } = hit;
      const anchor = anchorBefore(all, msg.sequence);
      if (anchor) {
        // 二次确认：回退是破坏性操作（锚点之后的内容从会话移除），防误点
        if (!confirm("[qw-edit] 将回退到这条消息之前：\n它之后的所有消息（含回答）会从本会话移除（磁盘原文件保留作审计），原输入会放回输入框供你修改重发。\n\n继续？")) return;
        btn.textContent = "…";
        const r = await withLock(sub.id, () =>
          trueRollback({ subChatId: sub.id, anchor, all, forbiddenTexts: [msg.text] }));
        // rollback 自带 broadcastChatMessagesInvalidated，UI 会自行刷新，无需重绑
        await waitComposer();
        fillComposer(msg.text);
        toast("已回退到该消息之前" + linesMsg(r) + "，修改后直接发送");
      } else {
        // 首条消息：无锚点 → 重建 subChat（投影清零，全新上下文，原消息保留在历史聊天里）
        if (!confirm("[qw-edit] 这是会话的第一条消息，将清空本会话并回填原文（编辑后直接发送）。\n继续？")) return;
        btn.textContent = "…";
        const newSub = await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        await rebindView(chat.id, chat.name || ""); // 重建 subChat 无广播 → 点走点回重新挂载（无重载）
        await waitComposer();
        fillComposer(msg.text);
        toast("已重置会话，原文已回填，修改后直接发送");
      }
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false; btn.innerHTML = _html;
    }
  }

  /* ---- 重新生成（助手消息）---- */
  function assistPrefix(el) {
    const pure = el.querySelector('div[class*="whitespace-pre-wrap"], p');
    return (pure ?? el).textContent || "";
  }
  async function onRegen(btn, bubble) {
    const _html = btn.innerHTML; // 保存原始内容，结束时原样恢复（修文字标签丢失 bug）
    btn.disabled = true; btn.textContent = "…";
    try {
      const ordinal = bubbleOrdinal(bubble, 'div[class*="container/assistant-message"]');
      const hits = await findMessages(assistPrefix(bubble), { role: "assistant", mode: "prefix" });
      const hit = pickByOrdinal(hits, "assistant", ordinal, assistPrefix(bubble), "prefix");
      if (!hit) throw opErr("cannot-confirm-target", "无法确认这条回答属于当前会话：请切换到其他会话再切回来后重试");
      const { msg: assist, all, chat, sub } = hit;
      // 原提问 = 该回答之前最近一条用户消息
      const userMsg = all.filter((x) => x.role === "user" && x.sequence < assist.sequence)
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (!userMsg) throw opErr("no-prompt", "这条回答之前没有提问，无法重新生成");
      const anchor = anchorBefore(all, userMsg.sequence);
      let targetSub = sub.id, targetChat = chat.id;
      if (anchor) {
        // 二次确认：回退 + 自动重发是破坏性操作（锚点之后的内容从会话移除），防误点
        if (!confirm("[qw-edit] 将回退到该回答之前并重新生成：\n该回答及之后的内容会从本会话移除（磁盘原文件保留作审计），并用原提问自动重新发送（消耗一次模型调用）。\n\n继续？")) return;
        btn.textContent = "…";
        // forbidden 只放被撤回轮的用户消息文本。锚点回答必须保留在遮蔽文件里，
        // 不加入 forbidden（锚点与被撤回回答文本相同时会误拦）
        const r = await withLock(sub.id, () =>
          trueRollback({ subChatId: sub.id, anchor, all, forbiddenTexts: [userMsg.text] }));
        btn.textContent = "…";
        await sleep(600);
        toast("已回退" + linesMsg(r) + "，重新生成中…");
      } else {
        // 第一组对话：无锚点 → 重建 subChat + 自动重发
        if (!confirm("[qw-edit] 这是会话的第一组对话，将重置会话并用原提问重新生成。\n继续？")) return;
        btn.textContent = "…";
        targetSub = await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        await sleep(300);
      }
      // 用原提问重新发送（runtime 将 resume 遮蔽文件 → 上下文为截断后内容）
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
      // API 提交对渲染层不可见 → 点走点回重新挂载视图（无重载）；完成后再刷一次
      await sleep(800);
      await rebindView(chat.id, chat.name || "");
      rebindAfterCompletion(chat.id, chat.name || "", targetSub);
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false; btn.innerHTML = _html;
    }
  }

  function fillComposer(text) {
    const composer = document.querySelector("textarea:not([readonly]), [contenteditable='true']");
    if (!composer) { prompt("[qw-edit] 已回退。原文如下，请复制后粘贴重发：", text); return; }
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
    firstTurnReinit, rebindView, sidebarItemsByName,
  };
  setInterval(mountButtons, 1500);
  log("v9.6 loaded (in-row regen icon + label-loss fix). 调试入口: window.__qwEdit");
})();
