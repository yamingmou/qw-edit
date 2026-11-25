#!/usr/bin/env node
// UI 级验收：真实点击第一条消息的"编辑重发"按钮，观察完整链路
const PORT = 9222;
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 300000);
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error(method + " timeout")), 280000);
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to); ws.removeEventListener("message", h);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expression) {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
    return r.result?.value;
  }
  // 收集页面 console
  await call("Runtime.enable");
  const logs = [];
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled" && m.params?.args) {
        logs.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
      }
    } catch {}
  });

  const setup = `(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 1. 建测试会话 + 一轮对话
    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    const det = await E.chatDetail(chatId);
    const sub0 = det.subs[0];
    await m("agent.submitMessage", { subChatId: sub0.id, chatId, prompt: "只回复两个字：苹果", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    for (let i = 0; i < 80; i++) {
      await sleep(3000);
      const sd = await q("chats.getSubChat", { id: sub0.id });
      if (!(sd?.json ?? sd)?.streamId) break;
    }
    const msgs = await E.loadMessages(sub0.id);
    if (!msgs.length) return { err: "对话未产生" };
    // 2. 打开该会话视图
    E.clickSidebarChat(chatId && (det.chat.name || ""));
    await sleep(1500);
    return { chatId, sub0: sub0.id, chatName: det.chat.name, msgCount: msgs.length };
  })()`;
  const s = await ev(setup);
  console.log("setup:", s);
  if (s.err) return;

  // 3. 自动接受 confirm，点击第一个"编辑重发"按钮
  const click = `(async () => {
    window.confirm = () => true;
    window.alert = (t) => console.log("[alert]", t);
    const btns = document.querySelectorAll(".qw-edit-btn");
    if (!btns.length) return { err: "无按钮（视图未打开？）" };
    // 第一条用户消息 = 最上面的按钮
    btns[0].click();
    await new Promise(r => setTimeout(r, 5000));
    // 检查状态
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const det = await E.chatDetail(${JSON.stringify(s.chatId)});
    const subNow = det.subs[0];
    const composer = document.querySelector("textarea:not([readonly]), [contenteditable='true']");
    return {
      newSubChatId: subNow?.id,
      oldSubChatGone: !det.subs.some(x => x.id === ${JSON.stringify(s.sub0)}),
      msgHosts: document.querySelectorAll('div[class*="container/user-message"]').length,
      composerValue: composer ? (composer.value || composer.textContent || "").slice(0, 30) : null,
    };
  })()`;
  console.log("click-result:", await ev(click));
  await new Promise(r => setTimeout(r, 1500));
  console.log("console logs:\n" + logs.filter(l => l.includes("qw-edit") || l.includes("alert")).join("\n"));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
