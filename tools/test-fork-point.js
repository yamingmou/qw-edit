#!/usr/bin/env node
// 最小 fork 实验：两轮回答文本不同，fork at t1，检查分叉文件实际保留到哪
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

  const script = `(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};

    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    const det = await E.chatDetail(chatId);
    const subChatId = det.subs[0].id;
    const srcSession = det.subs[0].sessionId;
    out.srcSession = srcSession;

    async function waitTurn(afterSeq) {
      for (let i = 0; i < 80; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const subD = await q("chats.getSubChat", { id: subChatId });
        const sd = subD?.json ?? subD;
        if (assist.length && !sd?.streamId) return { assist: assist[0], msgs };
      }
      return null;
    }

    const t1 = await waitTurn(-1).then(r => r && (await m("agent.submitMessage", { subChatId, chatId, prompt: "只回复两个字：苹果", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true }), r));
    // 上面写复杂了，重来：先提交再等
    return "REWRITE";
  })()`;
  // 上面的内联写法有误，直接在这里跑清晰版本
  const script2 = `(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};

    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    const det = await E.chatDetail(chatId);
    const subChatId = det.subs[0].id;
    out.srcSession = det.subs[0].sessionId;

    async function turn(prompt, afterSeq) {
      await m("agent.submitMessage", { subChatId, chatId, prompt, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
      for (let i = 0; i < 80; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const subD = await q("chats.getSubChat", { id: subChatId });
        const sd = subD?.json ?? subD;
        if (assist.length && !sd?.streamId) return { assist: assist[0], msgs };
      }
      return null;
    }

    const t1 = await turn("只回复两个字：苹果", -1);
    if (!t1) return { err: "t1 未完成" };
    const t2 = await turn("只回复两个字：香蕉", t1.assist.sequence);
    if (!t2) return { err: "t2 未完成" };
    out.t1 = { seq: t1.assist.sequence, uuid: t1.assist.sdkMessageUuid, text: t1.assist.text.slice(0, 20) };
    out.t2 = { seq: t2.assist.sequence, uuid: t2.assist.sdkMessageUuid, text: t2.assist.text.slice(0, 20) };

    // fork at t1
    const fork = await m("chats.forkFromMessage", { chatId, subChatId, sdkMessageUuid: t1.assist.sdkMessageUuid });
    const f = fork?.json ?? fork;
    if (!f?.subChatId) return { ...out, err: "fork failed: " + JSON.stringify(fork).slice(0, 300) };
    const branchRaw = await q("chats.getSubChat", { id: f.subChatId });
    out.branchSession = (branchRaw?.json ?? branchRaw)?.sessionId;
    out.branchChatId = f.chatId;
    // 不删除分支，供外部检查文件
    return out;
  })()`;

  console.log(await ev(script2));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
