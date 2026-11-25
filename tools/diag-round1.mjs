// 查 mvufa2ytoh8v1juw 实况：消息、状态、busy
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
  const d = await E.chatDetail('mvufa2ytoh8v1juw')
  const out = { subs: d.subs.map(s => s.id) }
  for (const s of d.subs) {
    const all = await E.loadMessages(s.id, { maxPages: 5 })
    const st = await E.subChatState(s.id)
    out[s.id] = { n: all.length, busy: !!(st && st.streamId), msgs: all.map(x => x.role[0] + ':' + (x.status || '') + ':' + (x.text || '').slice(0, 24)) }
  }
  return JSON.stringify(out, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
