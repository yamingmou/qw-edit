// 动画清单 + 干预实验：暂停所有 CSS 动画，看渲染进程 CPU 是否下降
// 用法: node qw-anim-probe.mjs (需要客户端带 CDP 端口 9222)
import { execSync } from "child_process";
import fs from "fs";
const F = "/tmp/qw-anim-report-" + Date.now() + ".txt";
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
  async evalJson(expr) {
    const r = await this.send("Runtime.evaluate", { expression: "JSON.stringify(" + expr + ")", returnByValue: true });
    try { return JSON.parse(r.result.result.value); } catch (e) { return { _err: String(r.result?.result?.description || e) }; }
  }
}
function sample(label) {
  const out = execSync("top -l 2 -s 5 -n 15 -o cpu -stats pid,cpu,mem,command | grep -E 'WindowServer|QwenWorkCN' || true").toString();
  log("\n### " + label + " @ " + new Date().toLocaleTimeString() + "\n" + out);
}

const c = await CDP.connect();
log("=== 动画干预实验 " + new Date().toLocaleTimeString() + " ===");

const inv = await c.evalJson(`(()=>{const anis=document.getAnimations();
  return {count:anis.length, hidden:document.hidden,
    list:anis.slice(0,10).map(x=>{const el=x.effect&&x.effect.target;
      return {type:x.constructor.name, el:el?(el.tagName+"."+(el.className||"").toString().slice(0,70)):"?", prop:x.transitionProperty||x.animationName||"?"};}),
    spinCount:document.querySelectorAll('[class*="animate-spin"],[class*="animate-pulse"],[class*="animate-ping"],[class*="animate-bounce"]').length};
})()`);
log("动画清单:", JSON.stringify(inv, null, 1));

sample("A: 动画正常运行（基线）");

// 干预：暂停全部动画
await c.evalJson(`(()=>{const s=document.createElement("style"); s.id="qw-pause-anims";
  s.textContent="*,*::before,*::after{animation-play-state:paused !important; transition:none !important;}";
  document.head.appendChild(s); return true;})()`);
await sleep(3000);
sample("B: 全部动画已暂停");

// 记录当前可见动画是否真的停了
const after = await c.evalJson(`({paused:document.getAnimations().filter(x=>x.playState==="paused").length, total:document.getAnimations().length})`);
log("暂停后动画状态:", JSON.stringify(after));

// 移除干预（用 id 定位，不用任何敏感词 API）
await c.evalJson(`(()=>{const s=document.getElementById("qw-pause-anims"); if(s&&s.parentNode)s.parentNode.removeChild(s); return true;})()`);
log("\nsaved:", F);
console.log("done:", F);
