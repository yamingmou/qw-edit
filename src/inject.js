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
  /* 当前会话的权威识别：侧边栏激活行（data-chat-item + 内部 aria-current）→ data-chat-id；
   * URL ?chat= 仅兜底（1.2.5 实锤：新任务原地首发后 URL 仍停留在旧会话）。 */
  function currentChatId() {
    for (const row of document.querySelectorAll("[data-chat-item][data-chat-id]")) {
      if (row.querySelector("[aria-current], [data-state='active'], [data-active='true']")) {
        const id = row.getAttribute("data-chat-id");
        if (id) return id;
      }
    }
    try { return new URLSearchParams(location.search).get("chat"); } catch { return null; }
  }
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
  function daemonOp(req, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { opResolvers.delete(id); resolve({ ok: false, error: "op-timeout" }); }, timeoutMs);
      opResolvers.set(id, (r) => { clearTimeout(timer); resolve(r); });
      opQueue.push({ id, ...req });
    });
  }

  /* ---------- 6. 核心：trueRollback（REBUILD 模式，1.2.5 定稿） ----------
   * 回退 = ① chats.rollbackToMessage 截断投影（UI 与上下文的唯一真相）
   *        ② 会话指向全新 sessionId（无转录文件）
   * 下次提交时客户端自动「从截断投影重建转录」：转录 ≡ 截断后的投影，
   * 被遮蔽内容按构造不可能进入模型上下文（隔离实验实证 n=4、零幽灵行）。
   * 旧「遮蔽转录文件 + 重指」路线在 1.2.5 会触发 runtime 回放/投影回灌
   * （"重新生成变追加"幽灵重复行），已废弃。
   * 异步诊断：等重建转录落盘，记录行数对比（daemon verifySession）。**仅写日志、不弹窗、不改数据**——
   * 因原会话与重建会话行数关系受 runtime 事件行数波动影响，做数值断言会假阳性（评审 #5）；
   * 真失忆由「先重指新 session、再截投影、循环到稳定、终检 survivors 为空」的构造性保证 +
   * 一次性实测文件级验证（重建转录真实用户轮只含存活消息）覆盖。 */
  async function trueRollback({ subChatId, anchor, all, forbiddenTexts, verify }) {
    await ensureIdle(subChatId);
    const src = await subChatState(subChatId);
    const originalSessionId = src?.sessionId || undefined;
    // 1. 指向全新 session（提交时由客户端从截断投影重建转录）
    const newSessionId = crypto.randomUUID();
    await m("chats.updateSubChatSession", { id: subChatId, sessionId: newSessionId });
    log("rebuild repoint ->", newSessionId);
    // 2. 截断投影 + 稳定循环。
    //    v10 隔离实验：1.2.5 里截断后 ~1-3 秒会出现一次性「复活波」（turn-input/事件流
    //    把刚删的行再物化 1-2 条），一波之后稳定、提交不再触发二次复活。
    //    对策：截断 → 观察 → 有复活行就再截断；循环后终检，仍不稳定则中止（调用方不会自动提交）。
    const truncateOnce = async () => {
      const rb = await m("chats.rollbackToMessage", { subChatId, sdkMessageUuid: anchor.sdkMessageUuid });
      if (rb && rb.success === false) throw opErr("rollback-failed", "回退失败: " + (rb.error || "未知错误"));
    };
    const survivors = async () => {
      const rows = await loadMessages(subChatId);
      return rows.filter((x) => x.sequence > anchor.sequence);
    };
    await truncateOnce();
    let bad = [];
    for (let round = 0; round < 4; round++) {
      await sleep(1600);
      bad = await survivors();
      if (!bad.length) { bad = []; break; }
      log("stabilize: 复活 " + bad.length + " 行，第 " + (round + 2) + " 次截断");
      await truncateOnce();
    }
    await sleep(1600);
    bad = await survivors();
    if (bad.length) {
      throw opErr("not-stable", "会话存在持续复活行（" + bad.length + " 条），为防错乱已中止。请重开本会话或稍后重试");
    }
    // 3. 异步诊断（仅重新生成路径）：等重建转录落盘并记录行数对比。
    //    行数关系受工具行数波动影响，不作为用户告警依据（评审 #5：只 log 不 toast）。
    if (verify) {
      void (async () => {
        const v = await daemonOp({ kind: "verify", sessionId: newSessionId, originalSessionId, waitMs: 90000 }, 110000);
        log("verify(diagnostic):", JSON.stringify(v));
      })();
    }
    return { newSessionId, rebuild: true };
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
  /* 侧边栏条目通用识别：项目分组是 li，"最近"分组是 div 行（button 直接子级）——
   * 统一为「侧边栏子树内 文本→closest(button)」。仅供删除流程（navigateAwayFrom）
   * 使用；编辑/重新生成绝不点击其它会话（不变式）。 */
  function sidebarItemsByName(chatName) {
    if (!chatName) return [];
    const side = document.querySelector('[class*="sidebar"]') || document.body;
    const out = [];
    const walker = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (!t || !(t === chatName || t.includes(chatName))) continue;
      const btn = node.parentElement?.closest("button");
      if (btn && side.contains(btn) && !out.includes(btn)) out.push(btn);
    }
    return out;
  }
  /* 视图重挂：**只回当前会话**——整页重载（URL 带 ?chat= 参数，重载即回原会话）。
   * 旧"点走点回"会去点其它会话条目，违反"编辑/重新生成绝不离开当前对话"不变式，
   * 且是"跳到其他对话"的唯一来源，已废除。
   * 重载后本脚本上下文消失：需跨重载续行的动作用 savePending 挂起，注入启动时接续。
   * 注：曾观察"重载后立即大量 tRPC 查询"致渲染进程假死——接续仅做轻量回填/官方输入框发送。 */
  const PENDING_KEY = "qw-edit-pending";
  function savePending(obj) { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...obj, ts: Date.now() })); } catch {} }
  async function restorePending() {
    let p = null;
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (raw) { sessionStorage.removeItem(PENDING_KEY); p = JSON.parse(raw); }
    } catch {}
    if (!p || !p.kind || Date.now() - (p.ts || 0) > 60000) return;
    const ta = await waitComposer(8000);
    if (!ta) {
      // 输入框迟迟未就绪：不把原文吞进 sessionStorage 死档，弹窗留存供复制
      uiPrompt(p.text || "").catch(() => {});
      toast("输入框未就绪，原文已弹窗留存，可复制后手动发送", "warn");
      return;
    }
    if (p.kind === "edit-draft") {
      if (p.chatId && currentChatId() !== p.chatId) {
        toast("已离开原会话，未回填草稿（防发错对话）", "warn");
        return;
      }
      fillComposer(p.text || "");
      toast("已重置会话，原文已回填，修改后直接发送");
    } else if (p.kind === "regen-send") {
      if (p.chatId && currentChatId() !== p.chatId) {
        toast("已离开原会话，未自动重发（防发错对话），原文如下可手动粘贴", "warn");
        return;
      }
      let sent = await sendViaComposer(p.text || "", p.subChatId, p.chatId);
      if (!sent && p.subChatId && p.chatId) {
        // 输入框路径失败 → tRPC 直提兜底（新 sub 在等待，绝不让会话停在空壳）
        try {
          const input = { subChatId: p.subChatId, chatId: p.chatId, prompt: p.text || "", cwd: p.cwd || "", historyEnabled: true };
          if (p.mode) input.mode = p.mode;
          await m("agent.submitMessage", input);
          sent = true;
          setTimeout(() => location.reload(), 400); // 直提对渲染层不可见 → 回本会话重载显示
        } catch {}
      }
      if (sent) toast("已重置会话并重新生成中…");
      else { fillComposer(p.text || ""); toast("无法自动发送，原文已回填，请手动发送", "warn"); }
    }
  }
  async function rebindView(chatId, chatNameHint) {
    // 重载前把 URL 的 chat 参数写正：新任务原地首发场景 URL 停在旧会话，
    // 直接 reload 会落回旧会话而不是刚重置的那个
    try {
      if (chatId) {
        const u = new URL(location.href);
        if (u.searchParams.get("chat") !== chatId) { u.searchParams.set("chat", chatId); history.replaceState(null, "", u.toString()); }
      }
    } catch {}
    setTimeout(() => location.reload(), 250);
    return true;
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
  const style2 = document.createElement("style");
  style2.textContent = `
    .qw-del-btn{position:absolute;right:26px;top:50%;transform:translateY(-50%);z-index:9998;border:none;background:transparent;
      cursor:pointer;font-size:13px;line-height:1;padding:3px;border-radius:5px;opacity:0;transition:opacity .15s}
    .qw-chat-row:hover>.qw-del-btn{opacity:.75}
    .qw-del-btn:hover{opacity:1 !important;background:rgba(239,68,68,.15)}
    .qw-trash-entry{position:fixed;top:10px;left:118px;z-index:99997;display:inline-flex;align-items:center;gap:4px;
      padding:4px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.35);
      background:var(--color-bg-base,rgba(255,255,255,.9));color:var(--text-base-primary,inherit);cursor:pointer;font-size:12px;
      -webkit-app-region:no-drag;box-shadow:0 1px 4px rgba(0,0,0,.12)}
    .qw-trash-entry:hover{background:var(--overlay-on-container-hover,rgba(128,128,128,.12))}
    .qw-admin-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .qw-admin{width:min(560px,92vw);max-height:min(640px,86vh);display:flex;flex-direction:column;background:var(--color-bg-base,#fff);
      color:var(--text-base-primary,#222);border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.35);overflow:hidden}
    .qw-admin-title{font-weight:600;padding:14px 16px 8px;font-size:15px}
    .qw-admin-body{overflow-y:auto;padding:0 16px;flex:1}
    .qw-admin-sec{margin:8px 0 12px}
    .qw-admin-sub{color:#999;font-weight:400;font-size:12px;margin-left:8px}
    .qw-admin-list{border:1px solid rgba(128,128,128,.25);border-radius:8px;max-height:200px;overflow-y:auto;margin-top:6px}
    .qw-admin-row{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(128,128,128,.12);font-size:13px;cursor:pointer}
    .qw-admin-row:last-child{border-bottom:none}
    .qw-admin-row:hover{background:rgba(128,128,128,.08)}
    .qw-admin-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .qw-admin-date{color:#999;font-size:11px}
    .qw-admin-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-top:1px solid rgba(128,128,128,.2)}
    .qw-admin-btn{padding:6px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:12px}
    .qw-admin-btn:hover{background:rgba(128,128,128,.1)}
    .qw-admin-danger{border-color:rgba(239,68,68,.6);color:#e05252}
    .qw-admin-danger:hover{background:rgba(239,68,68,.1)}
  `;
  document.head.appendChild(style2);
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
    return r?.rebuild ? "（历史将以截断后的投影重建，被撤回内容不再进入上下文）" : "";
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
  /* 在当前会话投影 all 里，精确定位「被点的这条用户气泡」对应的消息。
   * 编辑与重新生成【共用】此选择器——两者本质是同一问题：命中我实际点击的那条提问。
   * 顺序（宁停不错，绝不误伤）：
   *   1. 候选先用【精确相等】圈定（杜绝「前 30 字相同、后文不同」的两条被混进同一候选集）；
   *      仅当精确为空（带 @提及/附件等使 DOM 文本与转录略有差异）才退回【30 字前缀】兜底。
   *   2. 唯一候选直接返回。
   *   3. 多候选：先按「前后邻居对齐」打分取【唯一最高分】；并列则不臆断。
   *   4. 邻居无法唯一化 → 用「同文相对序数」在候选内定位（点击瞬间同步快照，抗窗口化列表）。
   *   5. 仍不确定 → 抛 ordinal-mismatch，交调用方提示重试。 */
  function selectUserMsg(all, bubble) {
    const expect = bubblePureText(bubble);
    if (!norm(expect)) throw opErr("cannot-locate-prompt", "无法识别所点消息内容，请滚动到该消息附近后重试");
    const uSel = 'div[class*="container/user-message"]';
    const rowsAll = [...document.querySelectorAll(uSel)];
    const idx = rowsAll.indexOf(bubble);
    // A1 守卫：本函数全同步（无 await），但进入前调用方已 await(chatDetail/loadMessages)。
    // 若那期间被点气泡被窗口化列表回收/组件重挂 → bubble 脱离 DOM(idx<0)，
    // 邻居快照与相对序数全部失去参照，此时【绝不】猜最后一条（旧 M2 错锚的变体），直接宁停。
    if (idx < 0) throw opErr("ordinal-mismatch", "所点消息已移出可视列表，请滚动到该消息附近后重试");
    const snapPrev = idx > 0 ? norm(bubblePureText(rowsAll[idx - 1])).slice(0, 20) : null;
    const snapNext = idx >= 0 && idx < rowsAll.length - 1 ? norm(bubblePureText(rowsAll[idx + 1])).slice(0, 20) : null;
    // 1) 候选：精确优先，空则前缀兜底（兼容 DOM 与转录文本略有差异的消息）
    let mode = "exact";
    let sameText = all.filter((x) => x.role === "user" && textConsistent(x.text, expect, "exact"));
    if (!sameText.length) {
      mode = "prefix";
      sameText = all.filter((x) => x.role === "user" && textConsistent(x.text, expect, "prefix"));
    }
    if (!sameText.length) throw opErr("cannot-locate-prompt", "当前会话内定位不到这条消息（列表未加载完整？），请滚动到该消息后重试");
    sameText = sameText.slice().sort((a, b) => a.sequence - b.sequence);
    if (sameText.length === 1) return sameText[0];
    // 2) 多候选：邻居对齐打分，找唯一最高分
    const near = (a, b) => !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
    const usersOnly = all.filter((x) => x.role === "user").sort((a, b) => a.sequence - b.sequence);
    const scoreOf = (x) => {
      const i = usersOnly.indexOf(x);
      const pv = i > 0 ? norm(usersOnly[i - 1].text).slice(0, 20) : null;
      const nx = i < usersOnly.length - 1 ? norm(usersOnly[i + 1].text).slice(0, 20) : null;
      let sc = 0;
      if (near(snapPrev, pv)) sc += 2;
      if (near(snapNext, nx)) sc += 1;
      return sc;
    };
    let best = null, bestScore = -1, tied = 0;
    sameText.forEach((x) => {
      const sc = scoreOf(x);
      if (sc > bestScore) { bestScore = sc; best = x; tied = 1; }
      else if (sc === bestScore) tied++;
    });
    if (best && bestScore > 0 && tied === 1) return best;
    // 3) 邻居无法唯一化 → 同文相对序数。
    //    A2 守卫：仅当【同文候选在 DOM 里都渲染出来了】(domSame 计数 == 候选数) 时，
    //    相对序数才有意义；若部分被虚拟化回收，序数会数错 → 宁停不错。
    const domSame = rowsAll.filter((el) => textConsistent(bubblePureText(el), expect, mode)).length;
    const rel = bubbleOrdinalAmong(bubble, "user", expect, mode);
    if (rel >= 0 && rel < sameText.length && domSame === sameText.length) return sameText[rel];
    throw opErr("ordinal-mismatch", "窗口化列表定位不确定，请滚动到该消息附近后重试");
  }
  /* 在当前会话内定位被点用户消息（1.2.5 列表窗口化：不跨会话搜索、不数全局序数）。 */
  async function locateUserMsgInCurrentChat(bubble) {
    const chatId = currentChatId();
    if (!chatId) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
    const { chat, subs } = await chatDetail(chatId);
    const sub = subs[0];
    if (!sub) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
    const all = await loadMessages(sub.id);
    const msg = selectUserMsg(all, bubble);
    return { msg, all, chat, sub };
  }

  async function onEdit(btn, bubble) {
    const _html = btn.innerHTML; // 保存原始内容，结束时原样恢复（修文字标签丢失 bug）
    btn.disabled = true; btn.textContent = "…";
    try {
      const { msg, all, chat, sub } = await locateUserMsgInCurrentChat(bubble);
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
        if (!(await uiConfirm({ title: "编辑重发", body: "这是会话的第一条消息。\n「重置」会把现有消息从本会话中删除（磁盘转录文件仍保留作审计），原文回填输入框供你修改后发送。\n\n继续？", confirmText: "重置会话" }))) return;
        btn.textContent = "…";
        await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        savePending({ kind: "edit-draft", text: msg.text, chatId: chat.id });
        await rebindView(chat.id, chat.name || ""); // sub 重建 → 整页重载回本会话；回填由 restorePending 接续
        return;
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
      // 语义（用户）：重新生成 = 取被点回答【前紧邻的那条提问】原样重发，不跨会话、不算完整度。
      // 1. 先用 DOM 精确取到该提问气泡（compareDocumentPosition，天然定位点击目标）
      const userBubble = prevUserBubble(bubble);
      if (!userBubble) throw opErr("no-prompt", "这条回答之前没有提问，无法重新生成");
      const promptText = bubblePureText(userBubble);
      if (!norm(promptText)) throw opErr("no-prompt", "这条回答之前没有提问，无法重新生成");
      // 2. 当前会话（侧边栏激活行为权威，URL 兜底），不跨会话搜索
      const chatId = currentChatId();
      if (!chatId) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
      const { chat, subs } = await chatDetail(chatId);
      const sub = subs[0];
      if (!sub) throw opErr("cannot-confirm-target", "无法确认当前会话，请重新进入对话后重试");
      const all = await loadMessages(sub.id);
      // 3. 用与编辑【同款】的严格定位器命中「被点回答前紧邻的那条提问」：
      //    精确优先→邻居/相对序数消歧→对不上宁停。修复「同会话有重复提问时错锚到最后一条」。
      const userMsg = selectUserMsg(all, userBubble);
      const anchor = anchorBefore(all, userMsg.sequence);
      let targetSub = sub.id, targetChat = chat.id;
      if (anchor) {
        // 二次确认：回退 + 自动重发是破坏性操作（锚点之后的内容从会话移除），防误点
        if (!(await uiConfirm({ title: "重新生成", body: "将回退到该回答之前并重新生成：\n该回答及之后的内容会从本会话移除（磁盘原文件保留作审计），并用原提问自动重新发送（消耗一次模型调用）。\n\n继续？", confirmText: "回退并重新生成" }))) return;
        btn.textContent = "…";
        // forbidden 只放被撤回轮的用户消息文本。锚点回答必须保留在遮蔽文件里，
        // 不加入 forbidden（锚点与被撤回回答文本相同时会误拦）
        const r = await withLock(sub.id, () =>
          trueRollback({ subChatId: sub.id, anchor, all, forbiddenTexts: [userMsg.text], stopBeforeTime: userMsg.createdAt, verify: true }));
        btn.textContent = "…";
        await sleep(600);
        toast("已回退" + linesMsg(r) + "，重新生成中…");
      } else {
        // 第一组对话：无锚点 → 重建 subChat + 自动重发
        if (!(await uiConfirm({ title: "重新生成", body: "这是会话的第一组对话。\n「重置」会把现有消息从本会话中删除（磁盘转录文件仍保留作审计），然后用原提问重新生成（消耗一次模型调用）。\n\n继续？", confirmText: "重置并重新生成" }))) return;
        btn.textContent = "…";
        targetSub = await withLock(sub.id, () => firstTurnReinit({ chatId: chat.id, sub }));
        savePending({ kind: "regen-send", text: userMsg.text, subChatId: targetSub, chatId: targetChat, cwd: chatCwd(chat), mode: sub?.mode || null });
        await rebindView(chat.id, chat.name || ""); // sub 重建 → 整页重载回本会话；重发由 restorePending 接续
        return;
      }
      // 用原提问重新发送。锚定回退后【必须】tRPC 直提，不走 composer：
      // 1.2.5 实锤（隔离实验 vs 全链路对比）——composer 提交时客户端会把
      // 「当前 runtime 的 sessionId」回写进库（submit 路径 sr&&set({sessionId})），
      // 把我们的重指覆盖回旧会话 → 写旧转录 → ensureProjectionBackfilled 把
      // 已截断的消息回灌进投影（表现＝"重新生成变成追加"）。
      // tRPC 直提在重指后走「runtime 不可复用 + 遮蔽转录存在 → resume 遮蔽」正路，
      // 隔离实验验证 4/4 干净。首轮 reinit 路径（新 sub 无 runtime）不受此影响。
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
      // 回答期间视图不动；完成后唯一一次重载显示最终答案（重载走 rebindView 写正 URL）
      rebindAfterCompletion(chat.id, chat.name || "", targetSub);
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
      if (expectedChatId && currentChatId() !== expectedChatId) return false;
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

  /* ---------- 10. 会话删除与回收站（A 侧边栏🗑 / B 回收站弹窗 / C 测试会话清理） ----------
   * 软删 chats.delete 进回收站可恢复；彻底删除 chats.permanentDelete 双重确认。
   * 安全：侧边栏 🗑 仅对名字唯一的会话挂载（同名歧义交给弹窗按 id 操作）；
   * 删除当前打开的会话前先导航到其它会话。 */
  let chatCache = { ts: 0, chats: [] };
  async function refreshChatCache(force = false) {
    if (!force && Date.now() - chatCache.ts < 5000) return chatCache.chats;
    try {
      let chats = await q("chats.listSidebar");
      chats = Array.isArray(chats) ? chats : (chats?.json ?? chats?.chats ?? []);
      chatCache = { ts: Date.now(), chats };
    } catch { /* 保留旧缓存 */ }
    return chatCache.chats;
  }
  async function navigateAwayFrom(chatId) {
    // 优先：按 data-chat-id 精确点其它会话行
    for (const row of document.querySelectorAll("[data-chat-item][data-chat-id]")) {
      if (row.getAttribute("data-chat-id") === chatId) continue;
      const btn = row.querySelector("button");
      if (!btn) continue;
      btn.click();
      await sleep(800);
      if (currentChatId() !== chatId) return true;
    }
    // 兜底：旧版无 data-chat-id → 名字匹配
    const chats = await refreshChatCache(true);
    for (const other of chats.filter((c) => c.id !== chatId).slice(0, 5)) {
      const items = sidebarItemsByName(other.name || "");
      if (items.length) {
        items[0].click();
        await sleep(800);
        if (currentChatId() !== chatId) return true;
      }
    }
    return currentChatId() !== chatId;
  }
  /* 无名会话在侧边栏显示为占位标题「新任务」，与顶部按钮撞文本：
   * 用位置规则识别（y>150 且非头部导航区）。仅当无名会话恰好一条时才认领该行。 */
  const UNNAMED_LABEL = "新任务";
  function unnamedRowOf() {
    const side = document.querySelector('[class*="sidebar"]') || document.body;
    const walker = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.textContent || "").trim() !== UNNAMED_LABEL) continue;
      const btn = node.parentElement?.closest("button");
      if (!btn || !side.contains(btn)) continue;
      const r = btn.getBoundingClientRect();
      if (r.top < 150 || r.left > 320) continue;          // 排除顶部「新任务」按钮
      const row = btn.parentElement || btn;
      if (row.querySelector(":scope > .qw-del-btn")) continue;
      return row;
    }
    return null;
  }
  function removeChatRow(ch) {
    let row = null;
    if (ch?.id) row = document.querySelector(`[data-chat-item][data-chat-id="${CSS.escape(ch.id)}"]`);
    if (!row) {
      const n = (ch?.name || "").trim();
      row = n ? chatRowOf(n) : unnamedRowOf();
    }
    if (row) row.remove();
  }
  async function trashChat(ch, { skipConfirm = false } = {}) {
    if (!ch?.id) return false;
    // 删除前实时校验：名字若已不唯一（缓存期撞名），拒绝按缓存 id 侧边栏删除
    {
      const n = (ch.name || "").trim();
      const fresh = await refreshChatCache(true);
      if (!fresh.some((c) => c.id === ch.id)) { toast("会话已变化，请重试", "warn"); return false; }
      if (n && fresh.filter((c) => (c.name || "").trim() === n).length > 1 &&
          !document.querySelector(`[data-chat-item][data-chat-id="${CSS.escape(ch.id)}"]`)) {
        toast(`「${n}」存在重名，出于安全请改用「回收站」弹窗勾选删除`, "warn");
        return false;
      }
    }
    if (!skipConfirm) {
      const ok = await uiConfirm({
        title: "删除会话",
        body: `「${(ch.name || "").trim() || "未命名会话"}」将移入回收站（之后可在「回收站」里恢复或彻底删除）。继续？`,
        confirmText: "移入回收站",
      });
      if (!ok) return false;
    }
    if (currentChatId() === ch.id && !(await navigateAwayFrom(ch.id))) {
      toast("无法切换到其它会话（可能只剩这一个会话），已取消删除", "warn");
      return false;
    }
    await m("chats.delete", { id: ch.id });
    removeChatRow(ch);
    toast(`会话「${ch.name || "未命名"}」已移入回收站`);
    return true;
  }
  async function permanentDeleteChats(items, { skipConfirm = false } = {}) {
    if (!items.length) return 0;
    if (!skipConfirm) {
      const names = items.slice(0, 5).map((c) => c.name || "未命名").join("、");
      const more = items.length > 5 ? ` 等 ${items.length} 个` : ` ${items.length} 个`;
      const ok1 = await uiConfirm({
        title: "彻底删除",
        body: `将永久删除${more}：${names}。\n不可恢复，关联工作区文件一并清理。`,
        confirmText: "继续",
      });
      if (!ok1) return 0;
      const ok2 = await uiConfirm({ title: "最后确认", body: "彻底删除后无法通过回收站找回。确认执行？", confirmText: "永久删除" });
      if (!ok2) return 0;
    }
    let n = 0;
    for (const c of items) {
      try {
        if (currentChatId() === c.id && !(await navigateAwayFrom(c.id))) {
          toast(`「${c.name}」是当前会话且无法切走，已跳过`, "warn");
          continue;
        }
        await m("chats.permanentDelete", { id: c.id });
        removeChatRow(c);
        n++;
      } catch (e) { toast(`彻底删除「${c.name}」失败: ${e.message}`, "err"); }
    }
    if (n) toast(`已彻底删除 ${n} 个会话`);
    return n;
  }

  /* A. 侧边栏悬停 🗑（仅名字唯一者）。条目结构有两种：项目分组是 li，"最近"分组是
   * button 的直接行容器（div.group.relative）——统一用"文本节点→closest(button)→父行"识别，
   * 且限定在 sidebar 子树内，避免误挂正文里恰好同名的文本。 */
  function chatRowOf(name) {
    const side = document.querySelector('[class*="sidebar"]') || document.body;
    const walker = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.textContent || "").trim() !== name) continue;
      const btn = node.parentElement?.closest("button");
      if (!btn) continue;
      if (!side.contains(btn)) continue;
      return btn.parentElement || btn;
    }
    return null;
  }
  async function mountSidebarDeleteButtons() {
    const chats = await refreshChatCache();
    const counts = {};
    const byName = new Map();
    for (const c of chats) {
      const n = (c.name || "").trim();
      if (!n) continue;
      counts[n] = (counts[n] || 0) + 1;
      byName.set(n, c);
    }
    const seen = new Set();
    const side = document.querySelector('[class*="sidebar"]') || document.body;
    // 优先：data-chat-id 精确挂（无重名歧义，名字唯一性要求仅限无名/旧版路径）
    let idBased = 0;
    for (const row of side.querySelectorAll("[data-chat-item][data-chat-id]")) {
      const ch = chats.find((c) => c.id === row.getAttribute("data-chat-id"));
      if (!ch) continue;
      idBased++;
      if (row.querySelector(":scope > .qw-del-btn")) continue;
      row.classList.add("qw-chat-row");
      if (getComputedStyle(row).position === "static") row.style.position = "relative";
      const b = document.createElement("button");
      b.className = "qw-del-btn";
      b.textContent = "🗑";
      b.title = "删除会话（移入回收站，可恢复）";
      b.onclick = (ev) => { ev.stopPropagation(); void trashChat(ch); };
      row.appendChild(b);
    }
    if (idBased) return; // 新版：id 精确路径完成
    // 旧版兜底：名字文本匹配（仅唯一名）
    const walker = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (!t || counts[t] !== 1) continue;
      const btn = node.parentElement?.closest("button");
      if (!btn) continue;
      const row = btn.parentElement || btn;
      if (!row || seen.has(row) || row.querySelector(":scope > .qw-del-btn")) continue;
      seen.add(row);
      row.classList.add("qw-chat-row");
      if (getComputedStyle(row).position === "static") row.style.position = "relative";
      const b = document.createElement("button");
      b.className = "qw-del-btn";
      b.textContent = "🗑";
      b.title = "删除会话（移入回收站，可恢复）";
      b.onclick = (ev) => { ev.stopPropagation(); void trashChat(byName.get(t)); };
      row.appendChild(b);
    }
    // 无名会话（侧边栏占位「新任务」）：仅一条时挂载，多条无法区分交给弹窗
    const unnamed = chats.filter((c) => !(c.name || "").trim());
    if (unnamed.length === 1) {
      const row = unnamedRowOf();
      if (row) {
        row.classList.add("qw-chat-row");
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        const b = document.createElement("button");
        b.className = "qw-del-btn";
        b.textContent = "🗑";
        b.title = "删除会话（未命名，移入回收站可恢复）";
        b.onclick = (ev) => { ev.stopPropagation(); void trashChat(unnamed[0]); };
        row.appendChild(b);
      }
    }
  }

  /* B+C. 回收站 / 清理 管理弹窗 */
  const TEST_PATTERNS = [/^测试/, /^要求?只回复/, /^要求回复/, /^回复好的/, /^只回复/, /^回复指定内容/, /^qw-e2e-/, /^好的$/, /^要求回复苹果/, /^不删不改/, /^回退的是/, /^重发走/, /^安全护栏/, /^遮蔽转录/, /^截断投影/, /^重指会话/, /^投影的/, /^客户端 resume/, /^失败路径/, /^编辑重发：/];
  function looksLikeTest(name) { return TEST_PATTERNS.some((re) => re.test((name || "").trim())); }
  async function openAdminModal() {
    if (document.querySelector(".qw-admin-overlay")) return;
    const ov = document.createElement("div");
    ov.className = "qw-admin-overlay";
    ov.innerHTML = `
      <div class="qw-admin" role="dialog" aria-modal="true" aria-label="qw-edit 会话管理">
        <div class="qw-admin-title">会话管理 · 回收站</div>
        <div class="qw-admin-body">
          <div class="qw-admin-sec"><b>当前会话</b><span class="qw-admin-sub">勾选后可移入回收站 / 彻底删除</span><div class="qw-admin-list" data-list="active"></div></div>
          <div class="qw-admin-sec"><b>回收站</b><span class="qw-admin-sub">已删除，可恢复或彻底删除</span><div class="qw-admin-list" data-list="trash"></div></div>
        </div>
        <div class="qw-admin-actions">
          <button data-act="pick-test" class="qw-admin-btn">勾选疑似测试会话</button>
          <button data-act="trash-sel" class="qw-admin-btn">移入回收站(所选)</button>
          <button data-act="restore-sel" class="qw-admin-btn">恢复(所选)</button>
          <button data-act="purge-sel" class="qw-admin-btn qw-admin-danger">彻底删除(所选)</button>
          <button data-act="empty-trash" class="qw-admin-btn qw-admin-danger">一键清空回收站</button>
          <button data-act="close" class="qw-admin-btn">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    let adminBusy = false;
    const runExclusive = async (fn) => {
      if (adminBusy) return;
      adminBusy = true;
      const btns = [...ov.querySelectorAll(".qw-admin-btn")];
      btns.forEach((b) => { b.disabled = true; });
      try { await fn(); }
      catch (e) { toast("操作失败: " + e.message, "err"); }
      finally { btns.forEach((b) => { b.disabled = false; }); adminBusy = false; }
    };
    const listBox = (key) => ov.querySelector(`[data-list="${key}"]`);
    const row = (c, kind) => {
      const r = document.createElement("label");
      r.className = "qw-admin-row";
      const when = kind === "trash" && c.deletedAt ? ` <span class="qw-admin-date">${new Date(c.deletedAt).toLocaleDateString()}</span>` : "";
      r.innerHTML = `<input type="checkbox" data-kind="${kind}" value="${escHtml(c.id)}"><span class="qw-admin-name">${escHtml(c.name || "未命名会话")}</span>${when}`;
      return r;
    };
    const reload = async () => {
      const act = await refreshChatCache(true);
      const boxA = listBox("active"); boxA.innerHTML = "";
      for (const c of act) boxA.appendChild(row(c, "active"));
      try {
        let d = await q("chats.listDeleted", {});
        d = d?.json ?? d;
        const trash = Array.isArray(d) ? d : (d?.chats ?? d?.items ?? []);
        const boxT = listBox("trash"); boxT.innerHTML = "";
        for (const c of trash) boxT.appendChild(row(c, "trash"));
      } catch (e) { const boxT = listBox("trash"); boxT.textContent = "回收站读取失败: " + e.message; }
    };
    const checkedOf = (kind) => [...ov.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((i) => i.value);
    ov.querySelector('[data-act="close"]').onclick = () => ov.remove();
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelector('[data-act="pick-test"]').onclick = () => {
      for (const i of ov.querySelectorAll('input[data-kind="active"]')) {
        const name = i.parentElement.querySelector(".qw-admin-name").textContent;
        if (looksLikeTest(name)) i.checked = true;
      }
    };
    ov.querySelector('[data-act="trash-sel"]').onclick = () => void runExclusive(async () => {
      const ids = new Set(checkedOf("active"));
      if (!ids.size) { toast("未勾选当前会话", "warn"); return; }
      const chats = await refreshChatCache(true);
      const items = chats.filter((c) => ids.has(c.id));
      const names = items.slice(0, 6).map((c) => c.name || "未命名").join("、");
      const ok = await uiConfirm({
        title: "移入回收站",
        body: `将把 ${items.length} 个会话移入回收站（可恢复）：${names}${items.length > 6 ? " 等" : ""}。继续？`,
        confirmText: "移入回收站", danger: false,
      });
      if (!ok) return;
      let n = 0;
      for (const c of items) {
        try { if (await trashChat(c, { skipConfirm: true })) n++; } catch (e) { toast(`删除「${c.name}」失败: ${e.message}`, "err"); }
      }
      toast(`已移入回收站 ${n}/${items.length} 个`);
      await reload();
    });
    ov.querySelector('[data-act="restore-sel"]').onclick = () => void runExclusive(async () => {
      const ids = checkedOf("trash");
      if (!ids.length) { toast("未勾选回收站项", "warn"); return; }
      let ok = 0;
      for (const id of ids) { try { await m("chats.restoreDeleted", { id }); ok++; } catch (e) { toast("恢复失败: " + e.message, "err"); } }
      toast(ok === ids.length ? `已恢复 ${ok} 个会话` : `恢复 ${ok}/${ids.length} 成功，其余失败`);
      await reload();
    });
    ov.querySelector('[data-act="purge-sel"]').onclick = () => void runExclusive(async () => {
      const aIds = new Set(checkedOf("active")), tIds = new Set(checkedOf("trash"));
      if (!aIds.size && !tIds.size) return toast("未勾选项", "warn");
      const items = [];
      if (aIds.size) for (const c of await refreshChatCache(true)) if (aIds.has(c.id)) items.push(c);
      if (tIds.size) {
        let d = await q("chats.listDeleted", {}); d = d?.json ?? d;
        const trash = Array.isArray(d) ? d : (d?.chats ?? []);
        for (const c of trash) if (tIds.has(c.id)) items.push(c);
      }
      await permanentDeleteChats(items);
      await reload();
    });
    ov.querySelector('[data-act="empty-trash"]').onclick = () => void runExclusive(async () => {
      let d = await q("chats.listDeleted", {}); d = d?.json ?? d;
      const trash = Array.isArray(d) ? d : (d?.chats ?? d?.items ?? []);
      if (!trash.length) { toast("回收站已是空的", "warn"); return; }
      const ok = await uiConfirm({
        title: "一键清空回收站",
        body: `回收站内共 ${trash.length} 个会话，将被【全部永久删除】（不可恢复，关联工作区文件一并清理）。\n\n这不是"移入回收站"，是真正删干净。确认清空？`,
        confirmText: "我知道，清空",
        danger: true,
      });
      if (!ok) return;
      const n = await permanentDeleteChats(trash); // 内部还会做一次"最后确认"
      toast(n ? `已清空回收站（${n} 项）` : "未删除任何会话");
      await reload();
    });
    await reload();
  }
  /* 入口：fixed 悬浮在顶部标题栏（logo 右侧空位）。标题栏是拖拽区，须声明 no-drag */
  function mountTrashEntry() {
    let b = document.querySelector(".qw-trash-entry");
    if (!b) {
      b = document.createElement("button");
      b.className = "qw-trash-entry";
      b.textContent = "🗑 回收站";
      b.title = "会话管理：删除 / 回收站 / 彻底删除";
      b.onclick = (ev) => { ev.stopPropagation(); void openAdminModal(); };
      document.body.appendChild(b);
    }
    if (b.parentElement !== document.body) document.body.appendChild(b); // 纠正旧版侧边栏位置
  }

  /* ---------- 9. 调试入口 & 启动 ---------- */
  window.__qwEdit = {
    trpc, findMessages, loadMessages, chatDetail, fillComposer,
    trueRollback, ensureIdle, subChatState, pinHits, daemonOp, toast,
    uiConfirm, uiPrompt, sendViaComposer,
    firstTurnReinit, rebindView, sidebarItemsByName, currentChatId,
    trashChat, permanentDeleteChats, openAdminModal, refreshChatCache, looksLikeTest,
    selectUserMsg,
  };
  setInterval(() => { mountButtons(); void mountTimes(); void mountSidebarDeleteButtons(); mountTrashEntry(); }, 1500);
  setTimeout(() => { void restorePending(); }, 2000);
  log("v9.29 loaded (REBUILD + stabilization w/ final check; shared strict selectUserMsg for edit+regen; single currentChatId; verify diagnostic-only; 回收站一键清空). 调试入口: window.__qwEdit");
})();
