// 1.5.0 部署后快速体检：时间戳/按钮/入口挂载数
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 2500) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `JSON.stringify({
  bridge: !!window.__qwEdit,
  times: document.querySelectorAll('[data-qw-time]').length,
  asst: document.querySelectorAll('div[class*="container/assistant-message"]').length,
  user: document.querySelectorAll('div[class*="container/user-message"]').length,
  edit: document.querySelectorAll('.qw-edit-btn').length,
  regen: document.querySelectorAll('.qw-regen-btn').length,
  inline: document.querySelectorAll('[data-qw-regen]').length,
  del: document.querySelectorAll('.qw-del-btn').length,
  trash: !!document.querySelector('.qw-trash-entry'),
  chat: window.__qwEdit ? window.__qwEdit.currentChatId() : null,
})`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 300))
ws.close()
process.exit(0)
