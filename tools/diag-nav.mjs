// 诊断：API 建会话经 openMainWindowWithChat 导航后，视图为什么 0 气泡
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
  const out = { url: location.search.slice(0, 90), bub: document.querySelectorAll('div[class*="container/user-message"]').length, asst: document.querySelectorAll('div[class*="container/assistant-message"]').length, body: (document.body.innerText || '').slice(0, 100) }
  try {
    let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
    const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
    out.inSidebar = chats.some(c => c.id === 'mvuev2uf7aimtruz')
    out.sidebarN = chats.length
    const d = await E.chatDetail('mvuev2uf7aimtruz')
    out.subs = d.subs.length
    const all = d.subs.length ? await E.loadMessages(d.subs[0].id, { maxPages: 3 }) : []
    out.projN = all.length
    out.first = all.length ? (all[0].text || '').slice(0, 20) : ''
  } catch (e) { out.err = String(e.message || e).slice(0, 120) }
  return JSON.stringify(out)
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 300))
ws.close()
process.exit(0)
