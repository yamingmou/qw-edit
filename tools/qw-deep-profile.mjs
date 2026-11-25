// 深挖归因：滚动 + 打开两个阶段的 CPU 火焰图 + 虚拟化回收验证
import fs from "fs";
const F = "/tmp/qw-deep-" + Date.now() + ".txt";
const log = (...a) => { fs.appendFileSync(F, a.join(" ") + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const cb = this.p.get(m.id); this.p.set(m.id, null); cb(m); }
    };
  }
  static async connect() {
    const t = await (await fetch("http://127.0.0.1:9222/json")).json();
    const page = t.find((x) => x.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res) => { this.p.set(id, res); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (!r.result) return { _cdp: JSON.stringify(r).slice(0, 150) };
    if (r.result.exceptionDetails) return { _err: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200) };
    return r.result.result.value;
  }
}
function summarize(profile, tag, save) {
  fs.writeFileSync(save, JSON.stringify(profile));
  const nodes = new Map();
  profile.nodes.forEach((n) => nodes.set(n.id, n));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], dt = profile.timeDeltas[i] || 0;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const top = [...self.entries()].map(([id, t]) => ({ n: nodes.get(id), t })).filter((x) => x.n)
    .sort((a, b) => b.t - a.t).slice(0, 22);
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  let out = `\n== ${tag}：采样总 ${(total / 1000).toFixed(0)}ms，Top 自耗时 ==\n`;
  for (const { n, t } of top) {
    const f = n.callFrame;
    out += (t / 1000).toFixed(0) + "ms | " + (f.functionName || "(anon)").slice(0, 55) + " | " + (f.url || "(vm)").split("/").slice(-1)[0].slice(0, 40) + ":" + (f.lineNumber + 1) + "\n";
  }
  return out;
}
const c = await CDP.connect();
await c.send("Page.enable"); await c.send("Runtime.enable");
log("=== 深挖归因 " + new Date().toLocaleTimeString() + " ===");
const hid = await c.eval(`JSON.stringify({hidden:document.hidden})`);
if (JSON.parse(hid).hidden) { console.log("ABORT hidden"); process.exit(2); }

// ---- Phase A: 滚动阶段 ----
const dom0 = await c.eval(`JSON.stringify({dom:document.querySelectorAll('*').length, bub:document.querySelectorAll('div[class*="container/assistant-message"],div[class*="container/user-message"]').length})`);
log("滚动前 DOM:", dom0);
await c.send("Profiler.enable");
await c.send("Profiler.start");
const sc = await c.eval(`JSON.stringify((()=>{const el=document.querySelector('[class*="content-scroll"]');if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})())`);
const scp = JSON.parse(sc);
if (scp) {
  for (let i = 0; i < 12; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scp.x, y: scp.y, deltaX: 0, deltaY: 500 }); await sleep(150); }
  for (let i = 0; i < 12; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scp.x, y: scp.y, deltaX: 0, deltaY: -500 }); await sleep(150); }
}
const stopA = await c.send("Profiler.stop");
log(summarize(stopA.result.profile, "滚动阶段(24次滚轮≈4s)", "/tmp/qw-prof-scroll.json"));
const dom1 = await c.eval(`JSON.stringify({dom:document.querySelectorAll('*').length, bub:document.querySelectorAll('div[class*="container/assistant-message"],div[class*="container/user-message"]').length})`);
log("滚动后 DOM:", dom1, "（对照滚动前——气泡数若只增不减=虚拟化未回收）");

// ---- Phase B: 打开大会话阶段 ----
const cid = await c.eval(`(()=>new URLSearchParams(location.search).get("chat")||"")()`);
const away = await c.eval(`JSON.stringify((()=>{const rows=[...document.querySelectorAll("[data-chat-item][data-chat-id]")].filter(r=>r.getAttribute("data-chat-id")!==${JSON.stringify(cid)});if(!rows.length)return null;const r=rows[0];const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})())`);
const aw = JSON.parse(away);
if (!aw) { console.log("no-away"); process.exit(3); }
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: aw.x, y: aw.y, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: aw.x, y: aw.y, button: "left", clickCount: 1 });
await sleep(3000);
await c.send("Profiler.start");
const home = await c.eval(`JSON.stringify((()=>{const r=document.querySelector('[data-chat-item][data-chat-id="${cid}"]');if(!r)return null;const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})())`);
const hp = JSON.parse(home);
if (!hp) { console.log("no-home"); process.exit(4); }
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: hp.x, y: hp.y, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hp.x, y: hp.y, button: "left", clickCount: 1 });
await sleep(3500);
const stopB = await c.send("Profiler.stop");
log(summarize(stopB.result.profile, "打开大会话阶段(点击后3.5s)", "/tmp/qw-prof-open.json"));
log("saved:", F);
process.exit(0);
