#!/usr/bin/env node
// E2E v4：唯一标记 + 序数定位验证。
// UI 建测试会话（t1 唯一标记）→ API t2（唯一标记）→ rebindView 显示 → 真实点击最后一条回答的 ↻
// 预期：序数定位选中 t2 的回答 → 锚点=t1回答 → 遮蔽回退 → 重发 t2 → 视图刷新显示新回答
const PORT = 9222;
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 420000);

async function getWS() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  if (!t) throw new Error("no page target");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return ws;
}
function makeCall(ws) {
  let idc = 0;
  return (method, params) => new Promise((res, rej) => {
    const id = ++idc;
    const to = setTimeout(() => { ws.removeEventListener("message", h); rej(new Error(method + " timeout")); }, 120000);
    function h(ev) {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(to); ws.removeEventListener("message", h);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let ws;
    try {
      ws = await getWS();
      const call = makeCall(ws);
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      ws.close();
      if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
      return r.result?.value;
    } catch (e) {
      try { ws?.close(); } catch {}
      if (/destroyed|timeout|Cannot find context/i.test(e.message)) { await sleep(2000); continue; }
      throw e;
    }
  }
  throw new Error("ev: all attempts failed");
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 7);
  const M1 = `qw${rand}甲`;
  const M2 = `qw${rand}乙`;
  const P1 = `${M1}：只回复：好的。`;
  const P2 = `我叫小明${M2}，只回复：好的。`;

  /* ---------- Phase A：UI 建会话 + t1（UI 发送） ---------- */
  const before = await ev(`(async () => {
    const E = window.__qwEdit;
    let chats = await E.trpc("query", "chats.listSidebar");
    chats = Array.isArray(chats) ? chats : (chats?.json ?? chats?.chats ?? []);
    return chats.map(c => c.id);
  })()`);
  const clicked = await ev(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => {
      const t = (b.textContent || "").trim();
      return t === "新任务" && !b.closest("li");
    });
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) { console.log("ERROR: 新任务 button not found"); process.exit(1); }
  await sleep(2500);
  const sent = await ev(`(() => {
    const E = window.__qwEdit;
    E.fillComposer(${JSON.stringify(P1)});
    const ta = document.querySelector("textarea:not([readonly]), [contenteditable='true']");
    if (!ta) return { err: "no composer" };
    for (const type of ["keydown", "keypress", "keyup"]) {
      ta.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return { ok: true };
  })()`);
  if (sent.err) { console.log("PhaseA err:", sent.err); process.exit(1); }
  await sleep(4000);
  const info = await ev(`(async () => {
    const E = window.__qwEdit;
    let chats = await E.trpc("query", "chats.listSidebar");
    chats = Array.isArray(chats) ? chats : (chats?.json ?? chats?.chats ?? []);
    const fresh = chats.filter(c => !${JSON.stringify(before)}.includes(c.id));
    if (!fresh.length) return { err: "no new chat" };
    const c = fresh[0];
    const det = await E.chatDetail(c.id);
    return { chatId: c.id, name: c.name, subChatId: det.subs[0].id };
  })()`);
  if (info.err) { console.log("PhaseA err:", info.err); process.exit(1); }
  console.log(`PhaseA: chat=${info.chatId} name="${info.name}" sub=${info.subChatId}`);
  const { chatId, subChatId } = info;

  /* ---------- Phase B：t2（API）+ rebind 显示 ---------- */
  const t2 = await ev(`(async () => {
    const E = window.__qwEdit;
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function waitTurn(afterSeq) {
      for (let i = 0; i < 90; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages("${subChatId}");
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const sd = await E.subChatState("${subChatId}");
        if (assist.length && !sd?.streamId) return assist[0];
      }
      return null;
    }
    const t1 = await waitTurn(-1);
    if (!t1) return { err: "t1 not completed" };
    await m("agent.submitMessage", { subChatId: "${subChatId}", chatId: "${chatId}", prompt: ${JSON.stringify(P2)}, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    const t2 = await waitTurn(t1.sequence);
    if (!t2) return { err: "t2 not completed" };
    return { t1seq: t1.sequence, t2seq: t2.sequence };
  })()`, 300000);
  if (t2.err) { console.log("PhaseB err:", t2.err); process.exit(1); }
  console.log("PhaseB: turns done", JSON.stringify(t2));

  const reb = await ev(`(async () => await window.__qwEdit.rebindView("${chatId}", ${JSON.stringify(info.name)}))()`);
  console.log("rebindView:", reb);
  let domBefore = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    domBefore = await ev(`(() => ({
      m1: document.body.innerText.includes("${M1}"),
      m2: document.body.innerText.includes("${M2}"),
      regenBtns: document.querySelectorAll(".qw-regen-btn").length,
    }))()`);
    if (domBefore.m1 && domBefore.m2) break;
  }
  console.log("domBefore:", JSON.stringify(domBefore));
  if (!domBefore.m1 || !domBefore.m2) {
    console.log("ERROR: view not on test chat — abort + cleanup");
    await ev(`window.__qwEdit.trpc("mutation", "chats.delete", { id: "${chatId}" })`).catch(() => {});
    process.exit(1);
  }

  /* ---------- Phase C：真实点击 ↻（最后一个助手气泡） ---------- */
  const clicked2 = await ev(`(() => {
    const btn = [...document.querySelectorAll(".qw-assist-msg")].pop()?.querySelector(".qw-regen-btn");
    if (!btn) return { err: "no btn" };
    btn.click();
    return { ok: true };
  })()`);
  if (clicked2.err) { console.log("PhaseC err:", clicked2); process.exit(1); }
  console.log("PhaseC: regen clicked (ordinal = last assistant bubble)");

  /* ---------- Phase D：轮询（M2 消失=回退可见；M2 重现=重发可见） ---------- */
  let sawRollback = false, sawResent = false, toastMsg = null;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    let st;
    try {
      st = await ev(`(() => {
        const t = document.body.innerText;
        return { m2: t.includes("${M2}"),
          toast: [...document.querySelectorAll("div")].map(d => d.textContent || "").filter(x => x.startsWith("[qw-edit]")).slice(-1)[0] || null };
      })()`);
    } catch (e) { console.log("poll err:", e.message); continue; }
    if (st.toast && st.toast !== toastMsg) { toastMsg = st.toast; console.log("toast:", toastMsg); }
    if (!st.m2 && !sawRollback) { sawRollback = true; console.log("poll: M2 gone — rollback visible ✓"); }
    if (st.m2 && sawRollback && !sawResent) { sawResent = true; console.log("poll: M2 back — resent turn visible ✓"); }
    if (sawResent) break;
    let idle = false;
    try { idle = await ev(`(async () => !(await window.__qwEdit.subChatState("${subChatId}"))?.streamId)()`); } catch {}
    if (idle && sawRollback && i > 5) break;
  }
  await sleep(5000);

  const domAfter = await ev(`(() => {
    const t = document.body.innerText;
    return { m1: t.includes("${M1}"), m2count: t.split("${M2}").length - 1,
      userBubbles: document.querySelectorAll('div[class*="container/user-message"]').length,
      assistBubbles: document.querySelectorAll('div[class*="container/assistant-message"]').length };
  })()`);
  const projection = await ev(`(async () => (await window.__qwEdit.loadMessages("${subChatId}"))
    .map(x => x.role[0] + ":" + x.text.slice(0, 18)))()`);
  console.log("domAfter:", JSON.stringify(domAfter));
  console.log("projection:", JSON.stringify(projection));

  /* ---------- Phase E：失忆验证 + 清理 ---------- */
  const amnesia = await ev(`(async () => {
    const E = window.__qwEdit;
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const msgs0 = await E.loadMessages("${subChatId}");
    const lastSeq = Math.max(...msgs0.map(x => x.sequence));
    await m("agent.submitMessage", { subChatId: "${subChatId}", chatId: "${chatId}", prompt: "我叫什么名字？只回复名字。", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    for (let i = 0; i < 90; i++) {
      await sleep(3000);
      const msgs = await E.loadMessages("${subChatId}");
      const assist = msgs.filter(x => x.role === "assistant" && x.sequence > lastSeq && x.sdkMessageUuid);
      const sd = await E.subChatState("${subChatId}");
      if (assist.length && !sd?.streamId) return assist[0].text.slice(0, 60);
    }
    return null;
  })()`, 300000);
  console.log("amnesia answer:", amnesia);
  await ev(`(async () => {
    const E = window.__qwEdit;
    await E.trpc("mutation", "chats.delete", { id: "${chatId}" });
    await E.rebindView("mu6tvojjeui2dkq3", "千问客户端输入编辑插件");
    return true;
  })()`).catch(() => {});
  console.log("cleaned & restored");

  // 断言：t1(M1) 在场、最后一轮是重发的 M2、失忆答案正确。
  // 不强求恰好 4 条（客户端会自动注入 system-reminder 轮次）、不强求轮询捕捉到 M2 消失的瞬态
  // （回退+重发+重绑可能在轮询间隔内完成；遮蔽截断以 daemon 日志 8/22 行为准）。
  const last = projection[projection.length - 2] || "";
  const ok = projection.some(x => x.includes("${M1}")) && last.includes("${M2}")
    && amnesia && amnesia.includes("小明");
  console.log("VERDICT:", ok ? "PASS" : "FAIL");
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
