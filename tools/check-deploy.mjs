// 部署后自检：等热重载，确认新拒绝文案与按钮在位
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `(async () => {
  await new Promise(r => setTimeout(r, 5000))
  const src = window.__qwEdit ? 'bridge-ok' : 'no-bridge'
  const btns = document.querySelectorAll('.qw-edit-btn').length
  const chat = window.__qwEdit ? window.__qwEdit.currentChatId() : null
  return JSON.stringify({ src, btns, chat })
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 25000 })
console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r).slice(0, 300))
ws.close()
process.exit(0)
