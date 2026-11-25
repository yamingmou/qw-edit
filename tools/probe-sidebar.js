#!/usr/bin/env node
// 探测侧边栏会话条目 DOM 结构
const PORT = 9222;
setTimeout(() => process.exit(2), 20000);
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
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
      // 找包含已知会话名的文本节点，向上走 DOM 链找可点击条目
      const names = ["千问客户端输入编辑插件", "回复苹果二字"];
      const out = {};
      for (const name of names) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node, el = null;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim().includes(name)) { el = node.parentElement; break; }
        }
        if (!el) { out[name] = null; continue; }
        const chain = [];
        let cur = el;
        for (let i = 0; i < 7 && cur; i++) {
          chain.push({
            tag: cur.tagName,
            cls: (cur.className && cur.className.toString ? cur.className.toString() : "").slice(0, 70),
            role: cur.getAttribute ? (cur.getAttribute("role") || cur.getAttribute("data-id") || null) : null,
          });
          cur = cur.parentElement;
        }
        out[name] = chain;
      }
      return JSON.stringify(out);
    } catch(e) { return JSON.stringify({err: String(e).slice(0,150)}); }
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(r.result?.value);
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
