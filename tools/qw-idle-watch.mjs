// 真·空闲观察器：由 launchd 拉起，脱离 agent 会话进程树存活
// 行为：静默 100 秒（等 agent 本轮结束）→ 每 60 秒采样一次（共 6 次）：
//   渲染进程 top CPU + 窗口可见性 + 是否有"任务运行中"证据(停止按钮/状态文本/动画数)
// 输出：/tmp/qw-real-idle.txt（下一轮对话读取）
import { execSync } from "child_process";
import fs from "fs";
const F = "/tmp/qw-real-idle.txt";
const log = (...a) => { fs.appendFileSync(F, a.join(" ") + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const cb = this.p.get(m.id); this.p.set(m.id, null); cb(m); } };
  }
  static async connect() {
    const t = await (await fetch("http://127.0.0.1:9222/json")).json();
    const page = t.find((x) => x.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  send(method, params) { const id = ++this.id; return new Promise((res) => { this.p.set(id, res); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (!r.result) return null; return r.result.result.value;
  }
}
// 防幽灵重启：done 标记存在则直接退出
if (fs.existsSync("/tmp/qw-real-idle-done2")) process.exit(0);
log("\n########## 观察器启动 " + new Date().toLocaleString() + " ##########");
await sleep(100000);
try { fs.writeFileSync("/tmp/qw-real-idle-done2", ""); } catch (e) {}
const esc = String.raw`QwenWorkCN Helper \(Renderer\)`;
let rendererPids = [];
try { rendererPids = execSync(`pgrep -f '${esc}'`).toString().trim().split("\n").filter(Boolean); } catch (e) {}
for (let i = 1; i <= 6; i++) {
  let st = "cdp-fail";
  try {
    const c = await CDP.connect();
    st = await c.eval(`JSON.stringify({hidden:document.hidden, anims:document.getAnimations().length,
      stopBtn:[...document.querySelectorAll('button')].some(b=>/停止|stop/i.test((b.getAttribute("aria-label")||"")+(b.title||"")+b.className)),
      status:(document.querySelector(".status-dots-anim")?.closest("button,[class*=input],[class*=flex]")?.innerText||"").replace(/\\s+/g," ").slice(0,40)})`);
    c.ws.close();
  } catch (e) { st = "err:" + e.message.slice(0, 60); }
  let topOut = "";
  try {
    topOut = rendererPids.map((p) => {
      const line = execSync(`ps -p ${p} -o pcpu=,rss=`).toString().trim();
      return `pid${p}: cpu=${(Number(line.split(/\s+/)[0]) || 0).toFixed(1)}% mem=${Math.round((Number(line.split(/\s+/)[1]) || 0) / 1024)}MB`;
    }).join(" | ") || "no-renderer-pid";
  } catch (e) { topOut = "ps-fail:" + e.message.slice(0, 40); }
  log(`采样${i} @ ${new Date().toLocaleTimeString()} | 渲染进程: ${topOut} | 状态: ${st}`);
  await sleep(60000);
}
log("观察完成 " + new Date().toLocaleTimeString());
try { execSync("launchctl remove gui/501/qw.idlewatch3 2>/dev/null; launchctl remove qw.idlewatch3 2>/dev/null; true"); } catch (e) {}
process.exit(0);
