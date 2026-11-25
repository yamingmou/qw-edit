// 诊断 1.5.0 首轮重置接续断点：会话状态 + sessionStorage pending + 视图位置
const CID = process.argv[2] || 'mw0fwwxvpbo6jrie'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1500) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `(async () => {
  const E = window.__qwEdit
  const out = { url: location.href.slice(0, 120), viewChat: E.currentChatId() }
  try { out.pending = sessionStorage.getItem('qw-edit-pending') } catch (e) { out.pending = 'ERR' }
  try {
    const det = await E.trpc('query', 'chats.get', { id: ${JSON.stringify(CID)} })
    const dd = (det && det.json) ? det.json : det
    const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
    out.subs = subs.map(s => ({ id: s.id, created: String(s.createdAt || '').slice(5, 16) }))
    for (const s of subs) { const all = await E.loadMessages(s.id, { maxPages: 3 }); out['n_' + s.id] = all.length }
  } catch (e) { out.chatErr = String(e.message || e).slice(0, 100) }
  out.modal = !!document.querySelector('.qw-modal-overlay')
  out.bubbles = document.querySelectorAll('div[class*="container/user-message"]').length
  return JSON.stringify(out, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
