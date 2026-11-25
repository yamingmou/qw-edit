// 终局判定：glow 动画是"运行中任务"的正常态，还是"卡死态"残留？
// 查：composer/停止按钮/状态点文本/loading-container + 动画元素矩形归属 + 两张截图存档
import fs from "fs";
const F = "/tmp/qw-final-" + Date.now() + ".txt";
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
    if (!r.result) return { _cdpErr: JSON.stringify(r).slice(0, 200) };
    if (r.result.exceptionDetails) return { _err: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300) };
    return r.result.result.value;
  }
}
const c = await CDP.connect();
await c.send("Page.enable");
log("=== 终局判定 " + new Date().toLocaleTimeString() + " ===");

// 1) 每个动画元素的位置矩形 + 状态点文本
const anims = await c.eval(`JSON.stringify(document.getAnimations().map(x=>{
  const el=x.effect&&x.effect.target; if(!el) return {name:x.animationName||"(tr)",noEl:true};
  const r=(el.getBoundingClientRect)?el.getBoundingClientRect():{x:0,y:0,width:0,height:0};
  return {name:x.animationName||x.transitionProperty||"(tr)", state:x.playState,
    rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
    cls:(el.className&&el.className.toString?el.className.toString():'').slice(0,50)};
}))`);
log("动画元素矩形:\n" + (typeof anims === "string" ? anims : JSON.stringify(anims)));

// 2) 任务态证据：停止按钮 / 状态点文本 / loading 遮罩
const state = await c.eval(`JSON.stringify({
  stopBtns: [...document.querySelectorAll('button,[role=button]')].filter(b=>{
    const s=(b.getAttribute("aria-label")||"")+(b.title||"")+b.className;
    return /停止|stop|Square|loading|spinner/i.test(s);}).length,
  statusDotsText: (()=>{const s=document.querySelector(".status-dots-anim");
    if(!s) return null; const p=s.closest("button,[role=button],[class*=input]")||s.parentElement;
    return (p&&p.innerText||"").replace(/\\s+/g," ").slice(0,120);})(),
  loadingContainers: [...document.querySelectorAll(".loading-container")].map(el=>{
    const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    return {opacity:cs.opacity, display:cs.display, visibility:cs.visibility, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};}),
  sendDisabled: (()=>{const s=[...document.querySelectorAll('button')].find(b=>/发送|send/i.test((b.getAttribute("aria-label")||"")+b.title));
    return s? !s.disabled : "no-send-btn";})()
})`);
log("任务态证据: " + state);

// 3) 两张截图（间隔 400ms）存档供肉眼比对
const shot = async (n) => {
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("/tmp/qw-shot-" + n + ".png", Buffer.from(r.result.data, "base64"));
};
await shot("A"); await sleep(400); await shot("B");
log("截图: /tmp/qw-shot-A.png /tmp/qw-shot-B.png");
log("saved:", F);
console.log("done");
