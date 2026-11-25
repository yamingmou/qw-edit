// 谁在每秒 125 帧重绘？
// 1) 全量动画清单（含 WAAPI）  2) 动图元素清单  3) 逐个停 WAAPI/动图并复测绘制事件
import { execSync } from "child_process";
import fs from "fs";
const F = "/tmp/qw-whopaints-" + Date.now() + ".txt";
const log = (...a) => { fs.appendFileSync(F, a.join(" ") + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const cb = this.p.get(m.id); this.p.set(m.id, null); cb(m); }
      else if (m.method === "Tracing.dataCollected") this.events.push(...(m.params.value || []));
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
  async evalJson(expr) {
    const r = await this.send("Runtime.evaluate", { expression: "JSON.stringify(" + expr + ")", returnByValue: true, awaitPromise: true });
    try { return JSON.parse(r.result.result.value); } catch (e) { return { _err: String(r.result?.result?.description || e) }; }
  }
}
async function paintCount(c, label) {
  c.events.length = 0;
  await c.send("Tracing.start", { traceConfig: { categories: "devtools.timeline", recordMode: "recordUntilFull" } });
  await sleep(5000);
  await c.send("Tracing.end");
  await sleep(1500);
  const names = {};
  for (const ev of c.events) {
    const n = ev.name || "";
    if (["PrePaint", "Paint", "Layerize", "Commit"].includes(n)) names[n] = (names[n] || 0) + 1;
  }
  const total = Object.values(names).reduce((a, b) => a + b, 0);
  log(label + " 5秒绘制:", JSON.stringify(names), "合计", total);
  return total;
}
const c = await CDP.connect();
log("=== 重绘源头侦查 " + new Date().toLocaleTimeString() + " ===");
const vis = await c.evalJson(`({hidden:document.hidden})`);
if (vis.hidden) { console.log("ABORT hidden"); process.exit(2); }

// 1) 全量动画清单
const anims = await c.evalJson(`(()=>{
  const info=document.getAnimations().map(x=>{const el=x.effect&&x.effect.target;
    let timing={}; try{timing=x.effect.getTiming();}catch(e){}
    return {type:x.constructor.name, name:x.animationName||x.transitionProperty||"(waapi)",
      playState:x.playState, el:el?el.tagName+"."+((el.className&&el.className.toString?el.className.toString():'')||'').slice(0,60):"?",
      iterations:timing.iterations, duration:timing.duration, id:x.id||""};});
  return info;})()`);
log("动画清单:\n" + JSON.stringify(anims, null, 1));

// 2) 动图元素
const gifs = await c.evalJson(`(()=>{
  const out=[];
  for(const im of document.querySelectorAll("img")){const s=(im.src||"").toLowerCase();
    if(s.endsWith(".gif")||s.endsWith(".apng")||s.includes(".webp")||s.startsWith("data:image/gif")){
      const r=im.getBoundingClientRect();
      if(r.width>0&&r.height>0) out.push({src:s.slice(0,90), rect:[r.x|0,r.y|0,r.width|0,r.height|0]});}}
  return out;})()`);
log("可见动图 img:", JSON.stringify(gifs));

// 3) 基线绘制计数
const base = await paintCount(c, "基线(什么都不动)");

// 4) 停掉所有 WAAPI 动画，复测
const stoppedWaapi = await c.evalJson(`(()=>{let n=0;document.getAnimations().forEach(x=>{try{if(x.constructor.name==="Animation"){x.pause();n++;}}catch(e){}});return n;})()`);
await sleep(2000);
const t2 = await paintCount(c, `停WAAPI(${stoppedWaapi}个)后`);

// 5) 隐藏动图（display:none），复测
const hiddenImgs = await c.evalJson(`(()=>{let n=0;for(const im of document.querySelectorAll("img")){const s=(im.src||"").toLowerCase();
  if(s.endsWith(".gif")||s.endsWith(".apng")||s.includes(".webp")||s.startsWith("data:image/gif")){im.dataset.qwHalt=im.style.display||"";im.style.display="none";n++;}}return n;})()`);
await sleep(2000);
const t3 = await paintCount(c, `隐藏动图(${hiddenImgs}个)后`);
// 恢复动图
await c.evalJson(`(()=>{document.querySelectorAll('img[data-qw-halt],img').forEach(im=>{if(im.dataset.qwHalt!==undefined){im.style.display=im.dataset.qwHalt; im.dataset.qwHalt=undefined;}});return true;})()`);

log("\n=== 判定 ===");
log(`基线 ${base} → 停WAAPI ${t2} (降幅 ${(((base - t2) / base) * 100).toFixed(0)}%) → 停WAAPI+动图 ${t3} (降幅 ${(((base - t3) / base) * 100).toFixed(0)}%)`);
log("saved:", F);
console.log("done:", F);
