#!/usr/bin/env node
// 测试侧边栏点击切换视图
const PORT = 9222;
setTimeout(() => process.exit(2), 30000);
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error("timeout")), 25000);
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to); ws.removeEventListener("message", h);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  const expr = `(async () => {
    try {
      const E = window.__qwEdit;
      if (!E) return JSON.stringify({ err: "no qwEdit" });
      const ok = E.clickSidebarChat("回复苹果二字");
      await new Promise(r => setTimeout(r, 3000));
      return JSON.stringify({
        clicked: ok,
        userHosts: document.querySelectorAll('div[class*="container/user-message"]').length,
        btns: document.querySelectorAll(".qw-edit-btn,.qw-regen-btn").length,
      });
    } catch (e) { return JSON.stringify({ err: String(e).slice(0, 150) }); }
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(r.result?.value);
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
