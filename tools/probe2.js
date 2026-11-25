#!/usr/bin/env node
// probe2: 定位当前会话 subChatId，填充注入脚本状态，验证消息列表可读
const PORT = 9222;
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 20000);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  if (!t) { console.error("target not found"); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error(method + " timeout")), 12000);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "").slice(0, 200));
    return r.result?.value;
  }

  const out = await ev(`(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    // 1. 列出会话找"千问客户端输入编辑插件"
    let chats = await q("chats.listSidebar");
    chats = chats?.json ?? chats ?? [];
    const target = chats.find(c => (c.name||"").includes("输入编辑插件")) || chats[0];
    // 2. 取详情拿 subChats
    let det = await q("chats.get", { id: target.id });
    det = det?.json ?? det;
    const subChats = det?.subChats ?? det?.chat?.subChats ?? [];
    // 3. 挑最新 subChat 填状态并拉消息
    const sorted = [...subChats].sort((a,b) => (b.updatedAt??b.createdAt??0).toString().localeCompare((a.updatedAt??a.createdAt??0).toString()));
    const sub = sorted[0];
    let msgInfo = null;
    if (sub?.id) {
      E.state.subChatId = sub.id;
      await E.refreshMessages();
      msgInfo = {
        subChatId: sub.id,
        total: E.state.messages.length,
        users: E.state.messages.filter(m => m.role === "user").length,
        lastUserText: (E.state.messages.filter(m => m.role === "user").slice(-1)[0] || {}).text?.slice(0, 40),
      };
    }
    return { chatName: target.name, chatId: target.id, subChatCount: subChats.length, subChats: sorted.slice(0,3).map(s => ({id:s.id, name:s.name, updatedAt:s.updatedAt})), msgInfo };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
