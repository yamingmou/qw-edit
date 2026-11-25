// 终局验证：窗口可见 + 空闲(不流式)状态下 ——
//   基线采样 → 合成器绘制事件计数 → 暂停全部动画 → 再采样+计数 → 恢复
// 因果判定：暂停动画后渲染进程 CPU / 绘制事件显著下降 ⇒ 动画即烧 CPU 的元凶
// 用法: node qw-verify-burn.mjs (需要客户端带 CDP 端口 9222；千问窗口须在前台可见)
import { execSync } from "child_process";
import fs from "fs";
const F = "/tmp/qw-burn-verdict-" + Date.now() + ".txt";
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
    const r = await this.send("Runtime.evaluate", { expression: "JSON.stringify(" + expr + ")", returnByValue: true });
    try { return JSON.parse(r.result.result.value); } catch (e) { return { _err: String(r.result?.result?.description || e) }; }
  }
}
function top2() {
  return execSync("top -l 2 -s 5 -n 20 -o cpu -stats pid,cpu,mem,command | grep -E 'WindowServer|QwenWorkCN' || true").toString();
}
// 5 秒合成器绘制事件计数
async function paintCount(c) {
  const ws = c;
  ws.events.length = 0;
  await ws.send("Tracing.start", { traceConfig: { categories: "devtools.timeline", recordMode: "recordUntilFull" } });
  await sleep(5000);
  const done = await ws.send("Tracing.end");
  // tracingComplete 事件在事件流里，等一下
  await sleep(1500);
  const names = {};
  for (const ev of ws.events) {
    const n = ev.name || "";
    if (["Paint", "PrePaint", "Rasterize", "FramePainted", "Layerize", "Commit", "CompositeLayers", "UpdateLayerTree"].includes(n)) names[n] = (names[n] || 0) + 1;
  }
  log("5秒绘制事件:", JSON.stringify(names));
  return names;
}

const c = await CDP.connect();
log("=== 空转烧 CPU 因果验证 " + new Date().toLocaleTimeString() + " ===");
const vis = await c.evalJson(`({hidden:document.hidden, anims:document.getAnimations().length})`);
log("窗口状态:", JSON.stringify(vis));
if (vis.hidden) { log("!! 窗口不可见，实验中止（遮挡节流会污染数据）"); console.log("ABORT hidden"); process.exit(2); }

log("\n[阶段1] 动画正常");
log(top2());
const p1 = await paintCount(c);

log("\n[阶段2] 暂停全部动画");
await c.evalJson(`(()=>{const s=document.createElement("style"); s.id="qw-pause-anims";
  s.textContent="*,*::before,*::after{animation-play-state:paused !important; transition:none !important;}";
  document.head.appendChild(s); return true;})()`);
await sleep(3000);
log(top2());
const p2 = await paintCount(c);

log("\n[阶段3] 恢复动画");
await c.evalJson(`(()=>{const s=document.getElementById("qw-pause-anims"); if(s&&s.parentNode)s.parentNode.removeChild(s); return true;})()`);
await sleep(2000);
const p3 = await c.evalJson(`({anims:document.getAnimations().length, paused:document.getAnimations().filter(x=>x.playState==="paused").length})`);
log("恢复后动画:", JSON.stringify(p3));

log("\n=== 判定 ===");
log(`阶段1(动画开) 5秒绘制事件合计: ${Object.values(p1).reduce((a, b) => a + b, 0)}`);
log(`阶段2(动画停) 5秒绘制事件合计: ${Object.values(p2).reduce((a, b) => a + b, 0)}`);
log("\nsaved:", F);
console.log("done:", F);
