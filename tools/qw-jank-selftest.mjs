// 千问办公"流式输出卡顿"实录自测：
// 真·新任务 + 真·长输出 + 真·键盘滚轮（CDP Input 域可信事件）
// 记录：主线程长任务 / Event Timing 输入延迟 / rAF 帧间隔 → 量化"卡"
import { execSync } from "child_process";
import fs from "fs";
const F = "/tmp/qw-jank-" + Date.now() + ".txt";
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
const c = await CDP.connect();
await c.send("Page.enable"); await c.send("Runtime.enable");
log("=== 流式卡顿实录 " + new Date().toLocaleTimeString() + " ===");
const hid = await c.eval(`JSON.stringify({hidden:document.hidden})`);
if (JSON.parse(hid).hidden) { console.log("ABORT hidden"); process.exit(2); }

// 1) 安装三类记录仪
await c.eval(`(()=>{
  window.__t0=performance.now();
  window.__lt=[]; try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({entryTypes:['longtask']})}catch(e){}
  window.__evt=[]; try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.name!=='first-input')window.__evt.push([e.name,Math.round(e.processingStart-e.startTime),Math.round(e.processingEnd-e.processingStart)])}).observe({type:'event',durationThreshold:16})}catch(e){}
  window.__fr=[]; let last=performance.now();
  const step=()=>{const n=performance.now();window.__fr.push(Math.round(n-last));last=n;if(window.__fr.length<4000)requestAnimationFrame(step)};
  requestAnimationFrame(step);
  return 'ok';})()`);

// 2) 真·新任务 + 提交长输出请求
const created = await c.eval(`(()=>{
  const btn=[...document.querySelectorAll("button")].find(b=>{const t=(b.innerText||"").trim();return t==="新任务"&&!b.closest("li")});
  if(!btn)return "no-btn"; btn.click(); return "clicked";})()`);
log("新任务:", created);
await sleep(2500);
const PROMPT = "用中文写一篇约3000字的科普长文《桥的历史》，分10个小节，每节有正文和一段示例代码块，结尾附一个中外名桥对比表格";
const sent = await c.eval(`(()=>{
  const E=window.__qwEdit; E.fillComposer(${JSON.stringify(PROMPT)});
  const ta=document.querySelector("textarea:not([readonly]), [contenteditable='true']");
  if(!ta)return{err:"no-composer"};
  for(const type of ["keydown","keypress","keyup"])ta.dispatchEvent(new KeyboardEvent(type,{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));
  return{ok:true};})()`);
log("提交:", JSON.stringify(sent));
await sleep(5000);

// 3) 流式期间注入真实输入（键盘+滚轮），采样 45 秒
const t0 = Date.now(); let keys = 0, wheels = 0;
while (Date.now() - t0 < 45000) {
  const k = Date.now() % 2 ? "a" : "s";
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: "Key" + k.toUpperCase(), text: k, windowsVirtualKeyCode: 65 + k.charCodeAt(0) - 97 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: 65 + k.charCodeAt(0) - 97 });
  keys++;
  if (keys % 2 === 0) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 120 });
    wheels++;
  }
  await sleep(300);
}
log(`注入完成: ${keys} 次按键, ${wheels} 次滚轮`);

// 4) 收集统计
const stats = await c.eval(`JSON.stringify((()=>{
  const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
  const lt=window.__lt||[], fr=window.__fr||[], ev=window.__evt||[];
  const kd=ev.filter(x=>x[0]==="keydown").map(x=>x[1]);
  const mo=ev.filter(x=>x[0]==="mousedown"||x[0]==="pointerdown").map(x=>x[1]);
  return {
    流式时长s: Math.round((performance.now()-(window.__t0||0))/1000),
    长任务: {次数:lt.length, 总耗时ms:lt.reduce((a,b)=>a+b,0), 最大ms:pct(lt,1), p95ms:pct(lt,0.95)},
    帧间隔ms: {p50:pct(fr,0.5), p95:pct(fr,0.95), 最大:pct(fr,1), 超33ms占比: fr.filter(x=>x>33).length+"/"+fr.length},
    键盘输入延迟ms: {次数:kd.length, p50:pct(kd,0.5), p95:pct(kd,0.95), 最大:pct(kd,1), 超100ms次数:kd.filter(x=>x>100).length},
    指针延迟ms: {次数:mo.length, p95:pct(mo,0.95), 最大:pct(mo,1)},
    动画在跑: document.getAnimations().length,
  };})())`);
log("统计:", stats);
try {
  const pid = execSync(`pgrep -f 'QwenWorkCN Helper \\(Renderer\\)' | head -1`).toString().trim();
  log("渲染进程瞬时:", execSync(`ps -p ${pid} -o pcpu=,rss=`).toString().trim());
} catch (e) { log("ps fail"); }

// 5) 清理测试会话（软删→彻底删）
const cleaned = await c.eval(`(async()=>{const E=window.__qwEdit;
  const cid=E.currentChatId?E.currentChatId():new URLSearchParams(location.search).get("chat");
  if(!cid)return "no-cid";
  try{await E.trpc("chats.delete",{id:cid});await E.trpc("chats.permanentDelete",{id:cid});return "cleaned "+cid;}
  catch(e){return "del-fail:"+String(e).slice(0,80);}})()`);
log("清理:", cleaned);
log("saved:", F);
console.log("done");
