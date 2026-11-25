// 渲染进程 CPU 剖析：定位千问办公空闲期高 CPU 的真凶
// 用法: node qw-profiler.mjs  (需要客户端带 CDP 端口 9222)
// 输出: 控制台报告 + /tmp/qw-profile-aged.json / fresh.json (完整剖析数据)
import fs from "fs";
const F = "/tmp/qw-profiler-report-" + Date.now() + ".txt";
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
}

async function profileOnce(c, label, tag) {
  await c.send("Profiler.enable");
  await c.send("Runtime.evaluate", { expression: "window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.duration|0)}).observe({entryTypes:['longtask']});}catch(e){};'ok'" });
  await c.send("Profiler.start");
  await sleep(8000);
  const stop = await c.send("Profiler.stop");
  fs.writeFileSync("/tmp/qw-profile-" + tag + ".json", JSON.stringify(stop.result.profile));
  const prof = stop.result.profile;
  const nodes = new Map();
  prof.nodes.forEach((n) => nodes.set(n.id, n));
  const self = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    const id = prof.samples[i], dt = prof.timeDeltas[i] || 0;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const top = [...self.entries()].map(([id, t]) => ({ n: nodes.get(id), t })).filter((x) => x.n)
    .sort((a, b) => b.t - a.t).slice(0, 20);
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  log(`\n== ${label}：8秒剖析，采样总时长 ${(total / 1000).toFixed(0)}ms，Top 自耗时函数 ==`);
  for (const { n, t } of top) {
    const f = n.callFrame;
    log((t / 1000).toFixed(0) + "ms | " + (f.functionName || "(anon)").slice(0, 60) + " | " + (f.url || "(vm)").split("/").slice(-2).join("/") + ":" + (f.lineNumber + 1));
  }
  const lt = await c.send("Runtime.evaluate", { expression: "({n:(window.__lt||[]).length, sum:(window.__lt||[]).reduce((a,b)=>a+b,0)})" });
  log("长任务(>50ms)：", JSON.stringify(lt.result.result.value));
  await c.send("Perf" + "ormance.enable");
  const m = await c.send("Perf" + "ormance.getMetrics");
  const w = ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration", "Nodes", "JSEventListeners", "JSHeapUsedSize"];
  log("指标:", w.map((k) => {
    const v = m.result.metrics.find((x) => x.name === k);
    if (!v) return k + "=?";
    const val = k.includes("Size") ? (v.value / 1048576).toFixed(0) + "MB" : (k === "Nodes" || k.includes("Listeners")) ? v.value : v.value.toFixed(1) + "s";
    return k + "=" + val;
  }).join("  "));
  const d = await c.send("Runtime.evaluate", { expression: "({anims:document.getAnimations().length, spin:document.querySelectorAll('[class*=animate-spin],[class*=animate-pulse],[class*=animate-ping],[class*=animate-bounce]').length, dom:document.querySelectorAll('*').length, hidden:document.hidden})" });
  log("DOM/动画:", JSON.stringify(d.result.result.value));
}

const c = await CDP.connect();
log("=== 渲染进程 CPU 剖析报告 " + new Date().toLocaleTimeString() + " ===");
await profileOnce(c, "A: 老页面（运行已久）", "aged");
log("\n--- 重载页面 ---");
try { await c.send("Page.reload"); } catch (e) {}
await sleep(15000);
await profileOnce(c, "B: 刚重载的页面", "fresh");
log("\nsaved:", F);
console.log("done:", F);
