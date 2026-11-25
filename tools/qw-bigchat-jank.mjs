// 二段实验：A) 清理+验证上轮流式测试会话  B) 超长会话"切出→切回→滚动"的渲染代价
import fs from "fs";
import { execSync } from "child_process";
const F = "/tmp/qw-bigchat-" + Date.now() + ".txt";
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
log("=== 大会话切换/滚动卡顿实验 " + new Date().toLocaleTimeString() + " ===");
const hid = await c.eval(`JSON.stringify({hidden:document.hidden})`);
if (JSON.parse(hid).hidden) { console.log("ABORT hidden"); process.exit(2); }

// A) 清理上轮遗留 + 验证确实流式渲染过
const cleanup = await c.eval(`(async()=>{const E=window.__qwEdit;
  const out=[];
  const list=await E.trpc("query","chats.listSidebar");
  const chats=list.chats||list;
  for(const ch of chats){
    const name=(ch.name||"").trim();
    const isJankTarget = /桥的历史|科普长文/.test(name);
    const isAnonShell = /^(新任务|未命名)|^\s*$/.test(name);
    if (isJankTarget || isAnonShell) {
      try {
        const det = await E.trpc("query", "chats.get", { id: ch.id });
        const sub = (det.subs && det.subs[0]) || null;
        if (sub) {
          const data = await E.trpc("query", "chats.listBySubChat", { subChatId: sub.id, limit: 10 });
          const msgs = (data.messages || data.list || []).filter((x) => x.role !== "system");
          if (!isJankTarget && msgs.length > 4) { out.push({ id: ch.id, name, msgCount: msgs.length, skip: "非测试体量，未动" }); continue; }
          const asst = msgs.find((x) => x.role === "assistant");
          const asstLen = asst ? ((asst.parts || "").length || JSON.stringify(asst).length) : 0;
          out.push({ id: ch.id, name: name.slice(0, 20), msgCount: msgs.length, asstLen });
          await E.trpc("mutation", "chats.delete", { id: ch.id });
          await E.trpc("mutation", "chats.permanentDelete", { id: ch.id });
          out[out.length - 1].deleted = true;
        }
      } catch (e) { out.push({ id: ch.id, name, del: "fail:" + String(e).slice(0, 60) }); }
    }
  }
  return JSON.stringify(out);})()`);
log("遗留清理+流式验证:", cleanup);

// B) 当前会话（超长开发对话）的 chatId
const cid = await c.eval(`(()=>new URLSearchParams(location.search).get("chat")||"")()`);
log("本会话 chatId:", cid);

// 找一个"别"的会话点出去
const away = await c.eval(`JSON.stringify((()=>{
  const rows=[...document.querySelectorAll("[data-chat-item][data-chat-id]")].filter(r=>r.getAttribute("data-chat-id")!==${JSON.stringify(cid)});
  if(!rows.length)return null; const r=rows[0]; const b=r.getBoundingClientRect();
  return {id:r.getAttribute("data-chat-id"), x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})())`);
log("切出目标:", away);

// 真实点击切出去
const aw = JSON.parse(away);
if (!aw) { console.log("no-away-row"); process.exit(3); }
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: aw.x, y: aw.y, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: aw.x, y: aw.y, button: "left", clickCount: 1 });
await sleep(3000);

// 装记录仪（全新计数），开始"切回"本会话
await c.eval(`(()=>{
  window.__t0=performance.now(); window.__lt=[]; window.__fr=[];
  new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({entryTypes:['longtask']});
  let last=performance.now();
  const step=()=>{const n=performance.now();window.__fr.push(Math.round(n-last));last=n;if(window.__fr.length<2000)requestAnimationFrame(step)};
  requestAnimationFrame(step); return 'ok';})()`);
const home = await c.eval(`JSON.stringify((()=>{
  const r=document.querySelector('[data-chat-item][data-chat-id="${cid}"]');
  if(!r)return null; const b=r.getBoundingClientRect();
  return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})())`);
const hp = JSON.parse(home);
if (!hp) { console.log("home-row-not-found"); process.exit(4); }
const clickAt = Date.now();
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: hp.x, y: hp.y, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hp.x, y: hp.y, button: "left", clickCount: 1 });
// 轮询直到本会话消息气泡出现
let appearMs = -1, firstBubbles = 0;
for (let i = 0; i < 60; i++) {
  await sleep(100);
  const n = await c.eval(`(()=>document.querySelectorAll('div[class*="container/assistant-message"],div[class*="container/user-message"]').length)()`);
  if (n > 0) { appearMs = Date.now() - clickAt; firstBubbles = n; break; }
}
log(`切回超大会话: 首屏气泡出现 ${appearMs}ms (${firstBubbles} 个)`);
// 等主线程消化完
await sleep(4000);
const openStats = await c.eval(`JSON.stringify((()=>{
  const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))]};
  return {打开阶段长任务:{次数:(window.__lt||[]).length,总ms:(window.__lt||[]).reduce((a,b)=>a+b,0),最大ms:pct(window.__lt||[],1)},
    打开阶段帧间隔:pct(window.__fr||[],0.95)};})())`);
log("打开代价:", openStats);

// 滚动长会话：真实滚轮 30 次（含向上回滚）
await c.eval(`window.__lt=[];window.__fr=[];(function(){let last=performance.now();const step=()=>{const n=performance.now();window.__fr.push(Math.round(n-last));last=n;if(window.__fr.length<1500)requestAnimationFrame(step)};requestAnimationFrame(step)})();'ok'`);
const sc = await c.eval(`JSON.stringify((()=>{const el=document.querySelector('[class*="content-scroll"]');if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})())`);
const scp = JSON.parse(sc);
if (scp) {
  for (let i = 0; i < 15; i++) await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scp.x, y: scp.y, deltaX: 0, deltaY: 400 }) && await sleep(120);
  for (let i = 0; i < 15; i++) await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scp.x, y: scp.y, deltaX: 0, deltaY: -400 }) && await sleep(120);
}
await sleep(1500);
const scrollStats = await c.eval(`JSON.stringify((()=>{
  const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))]};
  const lt=window.__lt||[],fr=window.__fr||[];
  return {滚动长任务:{次数:lt.length,总ms:lt.reduce((a,b)=>a+b,0),最大ms:pct(lt,1)},
    滚动帧间隔:{p50:pct(fr,0.5),p95:pct(fr,0.95),最大:pct(fr,1),超33ms:(fr.filter(x=>x>33).length)+"/"+fr.length}};})())`);
log("滚动代价:", scrollStats);
try {
  const pid = execSync(`pgrep -f 'QwenWorkCN Helper \\(Renderer\\)' | head -1`).toString().trim();
  log("渲染进程:", execSync(`ps -p ${pid} -o pcpu=,rss=`).toString().trim());
} catch (e) {}
log("saved:", F);
process.exit(0);
