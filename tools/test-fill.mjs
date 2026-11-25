// 验证新 fillComposer：在空壳会话里 填词→点发送→查投影是否真有这条消息
import { execFile } from 'node:child_process'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '壳验' + Math.random().toString(36).slice(2, 6)
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const ev = async (expression, ap = true) => {
  try {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
    if (r.error) return 'CDPERR:' + JSON.stringify(r.error).slice(0, 160)
    const inner = r.result && r.result.result
    if (inner && 'value' in inner) return inner.value
    const ex = r.result && r.result.exceptionDetails
    return ex ? 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 160) : 'NOVAL'
  } catch (e) { return 'TO:' + String(e).slice(0, 60) }
}
console.log('bridge:', await ev(`window.__qwEdit ? 'UP' : 'DOWN'`, false))
console.log('fill:', await ev(`(async () => { const E = window.__qwEdit; await E.fillComposer(${JSON.stringify(MARK + '。只回复：收到')}); const el = document.querySelector("[contenteditable='true'], textarea"); return 'FILLED:' + (el ? (el.value || el.textContent || '').slice(0, 20) : 'NONE') })()`))
await sleep(500)
console.log('send:', await ev(`(() => { const sb = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').match(/发送|send|提交/i)); if (sb) { sb.click(); return 'CLICKED' } return 'NO-BTN' })()`, false))
let landed = null
for (let k = 0; k < 30; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    const cid = new URLSearchParams(location.search).get('chat')
    const d = await E.chatDetail(cid)
    let n = 0, has = false, done = false
    for (const s of d.subs) { const all = await E.loadMessages(s.id, { maxPages: 3 }); n += all.length; has = has || all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0); done = done || all.some(x => x.role === 'assistant' && x.status === 'completed') }
    return JSON.stringify({ cid, subs: d.subs.length, n, has, done })
  })()`)
  console.log('poll', k, r)
  if (r && r.includes('"has":true')) { landed = r; break }
}
console.log(landed ? 'PASS: 消息真实落库 ' + landed : 'FAIL: 消息仍未落库')
execFile('/bin/sh', ['-c', `echo "MARK=${MARK}" > tools/out-fill.env`], () => {})
const fs = await import('node:fs')
fs.writeFileSync('tools/out-fill.env', 'MARK=' + MARK + '\n')
ws.close()
process.exit(landed ? 0 : 1)
