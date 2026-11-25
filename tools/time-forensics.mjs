// 取证：npm 那条消息的官方显示时间 vs 数据库原始 createdAt（最近几条对比）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const expr = `(async () => {
  const E = window.__qwEdit
  if (!E) return 'NOT-INJECTED'
  const det = await E.chatDetail(E.currentChatId())
  const sub = (det.subChats ?? det.subs ?? [])[0]
  const raw = await E.trpc('query', 'chats.listBySubChat', { subChatId: sub.id, limit: 200 })
  const msgs = ((raw?.json ?? raw)?.messages ?? []).filter(x => ['user','assistant'].includes(x.role))
  const last6 = msgs.slice(-6).map(x => ({
    role: x.role, seq: x.sequence,
    dbCreatedAt: x.createdAt ? new Date(x.createdAt).toISOString().slice(0,16).replace('T',' ') : null,
    metaSessionId: (x.metadata?.sessionId || '').slice(0, 8),
    text: (x.parts?.[0]?.text ?? x.text ?? '').replace(/\\s+/g,' ').slice(0, 22)
  }))
  // DOM：最近气泡里官方显示的时间文本（找含 2026- 或 :xx:xx 形态的节点）
  const dom = []
  document.querySelectorAll('div[class*="container/user-message"], div[class*="container/assistant-message"]').forEach(b => {
    const t = [...b.querySelectorAll('span,time,div')].map(el => el.textContent.trim()).filter(s => /2026-\\d\\d-\\d\\d.*\\d\\d:\\d\\d/.test(s) && s.length < 40)
    dom.push({ head: (b.innerText||'').replace(/\\s+/g,' ').slice(0, 18), officialTime: t[0] || null, ourTime: b.querySelector('[data-qw-time]')?.textContent || null })
  })
  return JSON.stringify({ chat: E.currentChatId().slice(0,12), db: last6, dom: dom.slice(-8) }, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
const v = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 200)
console.log(typeof v === 'string' ? v : JSON.stringify(v))
ws.close()
process.exit(0)
