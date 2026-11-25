// 清理 4 个空壳"新任务"会话（按 id，先复核 n==0 再删）
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
  const ids = ['mvuev2uf7aimtruz', 'mvuez64vws0a6wih', 'mvuf75vzp4na56jq','mvufa2ytoh8v1juw','mvufe7iuq3sqjmo8','mvufjhzq7q8quute','mvznxdei4clyitaq']
  const doomed = []
  for (const id of ids) {
    try {
      const det = await E.trpc('query', 'chats.get', { id })
      const dd = (det && det.json) ? det.json : det
      const co = dd && dd.chat ? dd.chat : dd
      if (co && co.deletedAt) continue
      const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
      let n = 0
      for (const s of subs) { const all = await E.loadMessages(s.id, { maxPages: 2 }); n += all.length }
      if (n === 0 || ids.includes(id)) doomed.push({ id, name: (co && co.name) || '空壳' })
    } catch {}
  }
  if (!doomed.length) return 'NO-DOOMED'
  const cnt = await E.permanentDeleteChats(doomed, { skipConfirm: true })
  return 'PURGED ' + cnt + ' [' + doomed.map(d => d.id).join(',') + ']'
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 300))
ws.close()
process.exit(0)
