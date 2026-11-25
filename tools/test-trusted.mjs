// 全可信用户模拟：新任务视图 → CDP 输入 → CDP 可信鼠标点发送 → 轮询落库；全程收 console 错误
import { execFile } from 'node:child_process'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '全验' + Math.random().toString(36).slice(2, 6)
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
const consoleErrs = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleErrs.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 120))
  }
}
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expression, ap = true) => {
  try {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
    const inner = r.result && r.result.result
    if (inner && 'value' in inner) return inner.value
    const ex = r.result && r.result.exceptionDetails
    return ex ? 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 140) : 'NOVAL'
  } catch (e) { return 'TO:' + String(e).slice(0, 60) }
}
await call('Runtime.enable')
await call('Page.enable')
// 1. 新任务视图
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x => !(x.closest('li')||x.closest('[data-chat-item]')) && /新任务/.test(x.textContent||'')); if (b) b.click(); return b?'NAV':'NO-NAV' })()`, false)
await sleep(2000)
// 2. focus + 可信输入
console.log('focus:', await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); if (!el) return 'NO-EDITOR'; el.click(); el.focus(); return 'FOCUS' })()`, false))
await call('Input.insertText', { text: MARK + '。只回复：收到' })
await sleep(400)
// 3. 发送按钮坐标 → 可信鼠标
const rect = await ev(`(() => { const sb=[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').match(/发送|send|提交/i)); if (!sb) return 'NO-BTN'; const r=sb.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, dis:!!sb.disabled}) })()`, false)
console.log('btn rect:', rect)
if (rect && rect.startsWith('{')) {
  const { x, y } = JSON.parse(rect)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  console.log('trusted click @', Math.round(x), Math.round(y))
}
let ok = false
for (let k = 0; k < 25; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
    const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
    for (const c of chats.slice(0, 6)) {
      const det = await E.trpc('query', 'chats.get', { id: c.id })
      const dd = (det && det.json) ? det.json : det
      const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
      for (const s of subs) {
        const all = await E.loadMessages(s.id, { maxPages: 3 })
        const has = all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0)
        if (has) return JSON.stringify({ chat: c.id, n: all.length, done: all.some(x => x.role === 'assistant' && x.status === 'completed') })
      }
    }
    return 'NOT-YET'
  })()`)
  console.log('poll', k, r)
  if (r && r.startsWith('{')) { ok = true; execFile('/bin/sh', ['-c', `echo 'CHAT=${(JSON.parse(r).chat)}' > tools/out-full.env`], () => {}); break }
}
console.log(ok ? 'PASS: 全可信路径发送成功' : 'FAIL')
console.log('console errors:', consoleErrs.slice(0, 6).join(' | ') || 'none')
ws.close()
process.exit(ok ? 0 : 1)
