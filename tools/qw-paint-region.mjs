// 终极侦查：像素 diff 找到每帧变化的区域 → 命中元素身份；顺带普查 iframe/video/canvas
// 用法: node qw-paint-region.mjs (需 CDP 9222 且窗口前台可见)
import fs from "fs";
const F = "/tmp/qw-paint-region-" + Date.now() + ".txt";
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
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) return { _err: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200) };
    try { return JSON.parse(r.result.result.value); } catch (e) { return { _raw: r.result.result.value }; }
  }
}
const c = await CDP.connect();
await c.send("Runtime.enable"); await c.send("Page.enable");
log("=== 每帧变化区域侦查 " + new Date().toLocaleTimeString() + " ===");
const vis = await c.evalJson("JSON.stringify({hidden:document.hidden})");
if (vis.hidden) { console.log("ABORT hidden"); process.exit(2); }

// 1) 元素普查
const census = await c.evalJson(`JSON.stringify({
  iframe: document.querySelectorAll("iframe").length,
  webview: document.querySelectorAll("webview").length,
  video: [...document.querySelectorAll("video")].filter(v=>!v.paused).length,
  canvas: [...document.querySelectorAll("canvas")].map(cv=>{const r=cv.getBoundingClientRect();return {w:r.width|0,h:r.height|0,cls:(cv.className||'').toString().slice(0,40)};}).filter(x=>x.w>0&&x.h>0).slice(0,5),
  backdrop: document.querySelectorAll('[class*="backdrop-filter"],[style*="backdrop-filter"]').length,
  willChange: [...document.querySelectorAll("*")].filter(el=>{const s=getComputedStyle(el);return s.willChange&&s.willChange!=="auto";}).length
})`);
log("普查:", JSON.stringify(census));

// 2) 像素 diff（两张截图间隔 400ms）
const shot = async () => (await c.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })).result.data;
const a = await shot(); await sleep(400); const b = await shot();
const diff = await c.evalJson(`(async()=>{
  const load=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=s;});
  const ia=await load("data:image/jpeg;base64,${a}"), ib=await load("data:image/jpeg;base64,${b}");
  const cv=document.createElement("canvas");cv.width=ia.width;cv.height=ia.height;
  const x=cv.getContext("2d",{willReadFrequently:true});
  x.drawImage(ia,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;
  x.drawImage(ib,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
  let x0=1e9,y0=1e9,x1=-1,y1=-1,cnt=0;
  for(let i=0;i<da.length;i+=4){
    if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>48){
      const px=(i/4)%cv.width,py=((i/4)/cv.width)|0;
      if(px<x0)x0=px;if(px>x1)x1=px;if(py<y0)y0=py;if(py>y1)y1=py;cnt++;}}
  const sx=innerWidth/cv.width, sy=innerHeight/cv.height;
  return JSON.stringify({img:[cv.width,cv.height], cssScale:[sx,sy].map(n=>+n.toFixed(2)),
    changed:cnt, pctOfScreen:+(cnt/(cv.width*cv.height)*100).toFixed(1),
    bboxPx:x1<0?null:[x0,y0,x1,y1], bboxCss:x1<0?null:[Math.round(x0*sx),Math.round(y0*sy),Math.round(x1*sx),Math.round(y1*sy)]});
})()`);
log("像素diff:", JSON.stringify(diff));

// 3) diff 中心 + 四角命中元素
if (diff.bboxCss) {
  const [x0, y0, x1, y1] = diff.bboxCss;
  const pts = [[(x0 + x1) >> 1, (y0 + y1) >> 1], [x0 + 5, y0 + 5], [x1 - 5, y1 - 5]];
  for (const [px, py] of pts) {
    const hit = await c.evalJson(`(()=>{const el=document.elementFromPoint(${px},${py});
      if(!el)return "null";
      const chain=[];let n=el;for(let i=0;i<5&&n;i++){chain.push(n.tagName+"."+((n.className&&n.className.toString?n.className.toString():'')||'').slice(0,60));n=n.parentElement;}
      return JSON.stringify({at:[${px},${py}],chain});})()`);
    log("命中:", JSON.stringify(hit));
  }
}

// 4) 对照实验：动画暂停后 diff 还变吗（若不变→CSS 动画即元凶；若仍变→合成器层动画）
await c.evalJson(`(()=>{const s=document.createElement("style");s.id="qw-pause2";
  s.textContent="*,*::before,*::after{animation-play-state:paused !important;transition:none !important;}";
  document.head.appendChild(s);return 1;})()`);
await sleep(800);
const a2 = await shot(); await sleep(400); const b2 = await shot();
const diff2 = await c.evalJson(`(async()=>{
  const load=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=s;});
  const ia=await load("data:image/jpeg;base64,${a2}"), ib=await load("data:image/jpeg;base64,${b2}");
  const cv=document.createElement("canvas");cv.width=ia.width;cv.height=ia.height;
  const x=cv.getContext("2d",{willReadFrequently:true});
  x.drawImage(ia,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;
  x.drawImage(ib,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
  let cnt=0;for(let i=0;i<da.length;i+=4){if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>48)cnt++;}
  return JSON.stringify({changedPaused:cnt});})()`);
await c.evalJson(`(()=>{const s=document.getElementById("qw-pause2");if(s&&s.parentNode)s.parentNode.removeChild(s);return 1;})()`);
log("暂停后像素diff:", JSON.stringify(diff2), "（对比：未暂停", diff.changed, "）");

log("saved:", F);
console.log("done:", F);
