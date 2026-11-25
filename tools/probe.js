#!/usr/bin/env node
// 一次性 CDP 探测：检查注入脚本状态 + 测试 tRPC 通道
const PORT = 9222;
const HARD_TIMEOUT = 15000;

setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, HARD_TIMEOUT);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log("targets:", targets.map(t => `[${t.type}] ${t.title} ${t.url.slice(0, 60)}`));
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  if (!t) { console.error("main page target not found"); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.addEventListener("error", (e) => { console.error("ws error"); process.exit(1); });
  await new Promise(r => ws.addEventListener("open", r));

  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error(method + " timeout")), 10000);
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to); ws.removeEventListener("message", h);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const expr = `(() => {
    const r = {};
    r.hasTRPC = !!window.electronTRPC;
    r.hasQwEdit = !!window.__qwEdit;
    r.subChatId = window.__qwEdit?.state?.subChatId || null;
    r.msgCount = window.__qwEdit?.state?.messages?.length || 0;
    r.btnCount = document.querySelectorAll(".qw-edit-btn").length;
    return r;
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log("state:", JSON.stringify(r.result?.value));

  // 若注入存在，试一次真实 tRPC 调用（只读查询 sidebar）
  if (r.result?.value?.hasQwEdit) {
    const expr2 = `window.__qwEdit.test().then(x => ({ok:true, n:(x&&(x.chats||x).length)||JSON.stringify(x).slice(0,120)})).catch(e => ({ok:false, err:String(e).slice(0,200)}))`;
    const r2 = await call("Runtime.evaluate", { expression: expr2, returnByValue: true, awaitPromise: true });
    console.log("trpc test:", JSON.stringify(r2.result?.value));
  }
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
