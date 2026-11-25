// 验证 CDP 可信输入路径：focus+全选 → Input.insertText → 点发送 → 查落库
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '信验' + Math.random().toString(36).slice(2, 6)
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
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
console.log('focus+select:', await ev(`(() => {
  const el = document.querySelector("[contenteditable='true'], textarea:not([readonly])")
  if (!el) return 'NO-EDITOR'
  el.focus()
  const sel = window.getSelection(); const range = document.createRange()
  range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range)
  return 'SELECTED'
})()`, false))
await call('Input.insertText', { text: MARK + '。只回复：收到' })
console.log('after insert:', await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); return (el.value || el.textContent || '').slice(0, 24) })()`, false))
await sleep(400)
console.log('send:', await ev(`(() => { const sb=[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').match(/发送|send|提交/i)); if (sb) { sb.click(); return 'CLICKED' } return 'NO-BTN' })()`, false))
let ok = false
for (let k = 0; k < 25; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    const cid = new URLSearchParams(location.search).get('chat')
    const d = await E.chatDetail(cid)
    let n = 0, has = false, done = false
    for (const s of d.subs) { const all = await E.loadMessages(s.id, { maxPages: 3 }); n += all.length; has = has || all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0); done = done || all.some(x => x.role === 'assistant' && x.status === 'completed') }
    return JSON.stringify({ n, has, done })
  })()`)
  console.log('poll', k, r)
  if (r && r.includes('"has":true')) { ok = true; break }
}
console.log(ok ? 'PASS: 可信输入路径消息真实落库' : 'FAIL: 仍未落库')
ws.close()
process.exit(ok ? 0 : 1)
