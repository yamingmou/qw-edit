// 查：锚测homn 会话是否被刚才的点击真正创建、消息与完成状态
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
  const E = window.__qwEdit
  let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
  const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
  const out = []
  for (const c of chats.slice(0, 12)) {
    const det = await E.trpc('query', 'chats.get', { id: c.id })
    const dd = (det && det.json) ? det.json : det
    const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
    let n = 0, done = false, first = ''
    if (subs.length) { const all = await E.loadMessages(subs[0].id, { maxPages: 3 }); n = all.length; done = all.some(x => x.role === 'assistant' && x.status === 'completed'); first = (all[0] && (all[0].text || '').slice(0, 20)) || '' }
    out.push({ name: (c.name || '').slice(0, 16), id: c.id, n, done, first })
  }
  return JSON.stringify({ url: location.search.slice(0, 80), chats: out })
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
