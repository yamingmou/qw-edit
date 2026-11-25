// 综合诊断版：输入→观测按钮/焦点/状态→可信点击发送→扩大轮询→截图→console 错误
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '综验' + Math.random().toString(36).slice(2, 6)
const TEXT = MARK + '。只回复：收到'
const fs = await import('node:fs')
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
const cerr = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') cerr.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 100))
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
console.log('nav:', await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x => !(x.closest('li')||x.closest('[data-chat-item]')) && /新任务/.test(x.textContent||'')); if (b) b.click(); return b?'NAV':'NO-NAV' })()`, false))
await sleep(2500)
const cpos = await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); if (!el) return 'NO-EDITOR'; const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+30, y:r.y+Math.min(20,r.height/2)}) })()`, false)
if (cpos && cpos.startsWith('{')) {
  const { x, y } = JSON.parse(cpos)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
await sleep(500)
for (const ch of TEXT) {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
  await call('Input.dispatchKeyEvent', { type: 'keyUp' })
}
await sleep(600)
// 观测：编辑器 DOM 文本 / 发送按钮状态 / 窗口焦点 / contenteditable 结构
console.log('state:', await ev(`(() => {
  const el = document.querySelector("[contenteditable='true'], textarea:not([readonly])")
  const sb = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').match(/发送|send|提交/i))
  const r = sb ? sb.getBoundingClientRect() : null
  return JSON.stringify({
    dom: (el.value || el.textContent || '').slice(0, 22),
    tag: el ? el.tagName : null,
    btnDis: sb ? !!sb.disabled : 'no-btn',
    btnAt: r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null,
    hasFocus: document.hasFocus(),
    activeEl: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 24) : null,
  })
})()`, false))
// 可信点击发送（用刚查到的坐标）
const st = JSON.parse(await ev(`(() => { const sb=[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').match(/发送|send|提交/i)); if (!sb) return '{}'; const r=sb.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}) })()`, false) || '{}')
if (st.x) {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: st.x, y: st.y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: st.x, y: st.y, button: 'left', clickCount: 1 })
  console.log('trusted send click @', Math.round(st.x), Math.round(st.y))
}
let ok = false
for (let k = 0; k < 20; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    const urlChat = new URLSearchParams(location.search).get('chat')
    let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
    const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
    const ids = [...new Set([urlChat, ...chats.slice(0, 12).map(c => c.id)].filter(Boolean))]
    for (const id of ids) {
      try {
        const det = await E.trpc('query', 'chats.get', { id })
        const dd = (det && det.json) ? det.json : det
        const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
        for (const s of subs) {
          const all = await E.loadMessages(s.id, { maxPages: 3 })
          if (all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0)) return JSON.stringify({ chat: id, n: all.length })
        }
      } catch {}
    }
    return 'NOT-YET'
  })()`)
  console.log('poll', k, r)
  if (r && r.startsWith('{')) { ok = true; break }
}
const s = await call('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('tools/out-shot4.png', Buffer.from(s.result.data, 'base64'))
console.log(ok ? 'PASS' : 'FAIL', '| console errors:', cerr.slice(0, 5).join(' || ') || 'none')
ws.close()
process.exit(ok ? 0 : 1)
