// 1.4.0 首条消息「重置式编辑」端到端测试（一次性会话，全程 UI 真实操作，容忍 reinit 引起的整页重载）
// 步骤：新任务→UI 发送带随机标记的提问→确认新引擎无锚点→点首条 ✎→自动确认「重置会话」→
//       等重载+草稿回填→改文本重发→追问暗号验证真失忆→按 id 清理
import fs from 'node:fs'
const rand = Math.random().toString(36).slice(2, 6)
const MARK = '锚测' + rand
const log = []
const t0 = Date.now()
const stamp = () => String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6) + 's '
const say = (...a) => { const s = stamp() + a.join(' '); log.push(s); console.log(s) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function conn() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(res, 2500) })
  const pend = new Map()
  let i = 0
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
  await call('Runtime.enable')
  // eval：出错/上下文销毁时返回 null 而不抛
  const ev = async (expression, awaitPromise = true, timeout = 20000) => {
    try {
      const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout })
      const inner = r.result && r.result.result
      if (inner && 'value' in inner) return inner.value
      const ex = r.result && r.result.exceptionDetails
      return ex ? 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 140) : null
    } catch { return null }
  }
  return { ws, call, ev }
}
let { ws, call, ev } = await conn()
const re = async () => { try { ws.close() } catch {} ; ({ ws, call, ev } = await conn()) }
// 部署热重载会销毁页面上下文——先等桥稳定（连续两次探活成功）再开工
for (let k = 0; k < 30; k++) {
  const ok = await ev(`window.__qwEdit ? 'UP' : 'DOWN'`, false)
  if (ok === 'UP') { const ok2 = await ev(`window.__qwEdit ? 'UP' : 'DOWN'`, false); if (ok2 === 'UP') break }
  await sleep(2000); await re()
}
say('桥稳定，开始')
// 1.4.0：合成 Enter 不触发发送，改点 composer 的圆形发送按钮（找不到再退 Enter）
const sendNow = () => ev(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const sb = btns.find(b => (b.getAttribute('aria-label') || '').match(/发送|send|提交/i))
    || btns.find(b => b.type === 'submit' && b.closest('form'))
    || btns.find(b => b.querySelector('svg') && /rounded-full/.test(b.className) && b.getBoundingClientRect().x > innerWidth * 0.5 && b.getBoundingClientRect().y > innerHeight * 0.6)
  if (sb) { sb.click(); return 'SENT-BTN:' + (sb.getAttribute('aria-label') || sb.className.slice(0, 30)) }
  const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  if (el) { el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return 'SENT-ENTER' }
  return 'NO-SEND'
})()`)
// 发送重试：上下文销毁/按钮未就绪时反复点，直到 SENT-* 返回
const sendRetry = async () => { for (let k = 0; k < 10; k++) { const r = await sendNow(); if (r && /^SENT/.test(r)) return r; await sleep(1500); await re() } return 'SEND-FAILED' }

// —— 1. 点「新任务」（排除侧边栏同名条目）——
say('打开新任务视图')
await ev(`(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => !(b.closest('li') || b.closest('[data-chat-item]')) && /新任务/.test(b.textContent || ''))
  if (btns[0]) { btns[0].click(); return 'clicked' } return 'NOT-FOUND'
})()`)
await sleep(2000)

// —— 2. composer 输入并发送 ——
const q1 = MARK + '。记住我的暗号是小明，只回复“记住了”'
say('发送第一轮:', q1.slice(0, 20))
await ev(`(async () => {
  const E = window.__qwEdit
  const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  if (!el) return 'NO-COMPOSER'
  await E.fillComposer(${JSON.stringify(q1)})
  return 'FILLED'
})()`)
await sleep(600)
await sendRetry().then(r => say('发送动作:', r))
// 等会话出现 + 第一轮完成（最多 120s）
let chatId = null, done1 = false
for (let k = 0; k < 60; k++) {
  await sleep(2500)
  const st = await ev(`(async () => {
    const E = window.__qwEdit; if (!E) return null
    const cid = E.currentChatId(); if (!cid) return null
    const d = await E.chatDetail(cid); const sub = d.subs[0]
    if (!sub) return null
    const all = await E.loadMessages(sub.id, { maxPages: 5 })
    const done = all.some(x => x.role === 'assistant' && x.status === 'completed')
    return JSON.stringify({ cid, sub: sub.id, n: all.length, done })
  })()`)
  if (st && st.startsWith('{')) { const j = JSON.parse(st); if (j.done) { chatId = j.cid; done1 = true; say('第一轮完成 chat=', chatId, 'sub=', j.sub, 'n=', j.n); break } }
  if (k % 8 === 7) say('等待第一轮…', k)
}
if (!done1) { say('FAIL: 第一轮未完成'); fs.writeFileSync('tools/out-firstturn.json', log.join('\n')); process.exit(1) }

// —— 3. 确认 1.4.0 无锚点（新引擎样本复现）——
const meta = await ev(`(async () => {
  const E = window.__qwEdit
  const d = await E.chatDetail(${JSON.stringify(chatId)}); const all = await E.loadMessages(d.subs[0].id, { maxPages: 5 })
  const asst = all.filter(x => x.role === 'assistant')
  return JSON.stringify({ sub: d.subs[0].id, n: all.length, asst: asst.length, withUuid: asst.filter(x => x.sdkMessageUuid).length, era: E.detectEra(all) })
})()`)
say('锚点实况:', meta)
const mj = JSON.parse(meta || '{}')

// —— 4. 点首条消息的 ✎（先断言视图在本测试会话）——
const viewOk = await ev(`(() => (document.body.innerText || '').indexOf(${JSON.stringify(MARK)}) >= 0 ? 'ON-TARGET' : 'OFF-TARGET')()`)
if (viewOk !== 'ON-TARGET') { say('FAIL: 视图不在测试会话', viewOk); fs.writeFileSync('tools/out-firstturn.json', log.join('\n')); process.exit(1) }
say('点击首条 ✎')
await ev(`(() => {
  const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const t = bub.find(e => ((e.querySelector('div[class*="whitespace-pre-wrap"]') || e).textContent || '').indexOf(${JSON.stringify(MARK)}) === 0)
  const btn = t && t.querySelector('.qw-edit-btn')
  if (btn) { btn.click(); return 'CLICKED' } return 'BTN-NOT-FOUND'
})()`)
await sleep(1200)
// 自动应答 uiConfirm（点「重置会话」）
const conf = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /重置会话/.test(x.textContent || ''))
  if (b) { b.click(); return 'CONFIRMED' } return 'NO-MODAL:' + [...document.querySelectorAll('button')].map(x => (x.textContent || '').slice(0, 8)).join('|').slice(0, 120)
})()`)
say('确认框:', conf)

// —— 5. 容忍重载，等草稿回填（最多 60s）——
let drafted = false
for (let k = 0; k < 24; k++) {
  await sleep(2500); await re()
  const d = await ev(`(() => { const el=document.querySelector("textarea:not([readonly]), [contenteditable='true']"); const v=el?(el.value||el.textContent||''):''; return v.indexOf(${JSON.stringify(MARK)}) >= 0 ? 'DRAFT-OK' : 'DRAFT-'+v.slice(0,14) })()`)
  if (d === 'DRAFT-OK') { drafted = true; say('草稿已回填（sub 已重建）'); break }
  if (k % 6 === 5) say('等待草稿…', k, d)
}
if (!drafted) { say('FAIL: 草稿未回填'); fs.writeFileSync('tools/out-firstturn.json', log.join('\n')); process.exit(1) }
// 断言 sub 已换新且投影清零
const after = await ev(`(async () => {
  const E = window.__qwEdit; const cid = E.currentChatId()
  const d = await E.chatDetail(cid); const all = await E.loadMessages(d.subs[0].id, { maxPages: 5 })
  return JSON.stringify({ cid, sub: d.subs[0].id, n: all.length })
})()`)
say('重建后:', after, '（旧 sub=', mj.sub, '）')

// —— 6. 改草稿重发（小明→小红）——
const q2 = MARK + '。记住我的暗号是小红，只回复“记住了”'
await ev(`(async () => { const E = window.__qwEdit; await E.fillComposer(${JSON.stringify(q2)}); return 'REFILL' })()`)
await sleep(500)
await sendRetry().then(r => say('发送动作:', r))
let done2 = false
for (let k = 0; k < 40; k++) {
  await sleep(2500)
  const st = await ev(`(async () => { const E=window.__qwEdit; const cid=E.currentChatId(); const d=await E.chatDetail(cid); const all=await E.loadMessages(d.subs[0].id,{maxPages:5}); return JSON.stringify({n:all.length, done: all.filter(x=>x.role==='assistant'&&x.status==='completed').length}) })()`)
  if (st && st.startsWith('{')) { const j = JSON.parse(st); if (j.done >= 1 && j.n >= 2) { done2 = true; say('重发轮完成 n=', j.n); break } }
}
if (!done2) { say('FAIL: 重发未完成'); fs.writeFileSync('tools/out-firstturn.json', log.join('\n')); process.exit(1) }

// —— 7. 追问暗号（应为小红，不知小明）——
await ev(`(async () => { const E = window.__qwEdit; await E.fillComposer('我的暗号是什么？只回答名字'); return await E.sendViaComposer ? 'SND' : 'SND2' })()`)
await sendRetry().then(r => say('发送动作:', r))
let ans = ''
for (let k = 0; k < 40; k++) {
  await sleep(2500)
  const a = await ev(`(async () => { const E=window.__qwEdit; const cid=E.currentChatId(); const d=await E.chatDetail(cid); const all=await E.loadMessages(d.subs[0].id,{maxPages:5}); const last=all.filter(x=>x.role==='assistant'&&x.status==='completed').pop(); return last?last.text.slice(0,60):'' })()`)
  if (a && a.length > 0 && /红|明|不知道|什么/.test(a)) { ans = a; break }
}
say('暗号回答:', JSON.stringify(ans))
const amnesia = /红/.test(ans) && !/小明/.test(ans)
say(amnesia ? 'PASS: 重置后新暗号生效且旧暗号不存在（全新上下文成立）' : 'CHECK: 需人工看回答')

// —— 8. 清理 ——
const cleaned = await ev(`(async () => {
  const E = window.__qwEdit; const cid = E.currentChatId()
  try { const n = await E.permanentDeleteChats([{ id: cid, name: ${JSON.stringify(MARK)} }], { skipConfirm: true }); return 'PURGED ' + cid + ' n=' + n } catch (e) { return 'PURGE-FAIL ' + e.message.slice(0, 60) }
})()`)
say('清理:', cleaned)
fs.writeFileSync('tools/out-firstturn.json', log.join('\n') + '\nRESULT ' + (amnesia ? 'PASS' : 'CHECK') + '\n')
ws.close()
process.exit(0)
