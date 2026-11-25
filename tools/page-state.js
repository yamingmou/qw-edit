#!/usr/bin/env node
// 页面状态探测（避免内联转义问题）
const PORT = 9222;
setTimeout(() => process.exit(2), 20000);
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  if (!t) { console.log("NO PAGE"); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error("timeout")), 15000);
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to); ws.removeEventListener("message", h);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  const expr = `(function(){
    try {
      return JSON.stringify({
        qw: !!window.__qwEdit,
        btns: document.querySelectorAll(".qw-edit-btn,.qw-regen-btn").length,
        userHosts: document.querySelectorAll('div[class*="container/user-message"]').length,
        assistHosts: document.querySelectorAll('div[class*="container/assistant-message"]').length,
      });
    } catch(e) { return JSON.stringify({err: String(e).slice(0,120)}); }
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log("page:", r.result?.value);
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
