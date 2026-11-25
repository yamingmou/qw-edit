// 查：各测试标记消息到底落到了哪个会话（重点：插件开发者 2 = mvfhzb4t961plcac 的队列/投影）
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
  const marks = ['壳验', '信验', '全验', '键验', '综验', '清验']
  let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
  const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
  const out = []
  for (const c of chats.slice(0, 14)) {
    const det = await E.trpc('query', 'chats.get', { id: c.id })
    const dd = (det && det.json) ? det.json : det
    const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
    let n = 0, hits = []
    for (const s of subs) {
      const all = await E.loadMessages(s.id, { maxPages: 10 })
      n += all.length
      for (const x of all) if (x.role === 'user') for (const mk of marks) if ((x.text || '').indexOf(mk) === 0) hits.push(mk + '@seq' + x.sequence)
    }
    if (hits.length || n <= 2) out.push({ name: (c.name || '').slice(0, 14), id: c.id, n, hits })
  }
  // 也查 getSubChat 的队列字段
  const cid = 'mvfhzb4t961plcac'
  const d2 = await E.chatDetail(cid)
  const st = await E.subChatState(d2.subs[0].id)
  return JSON.stringify({ out, mySub: { n: (await E.loadMessages(d2.subs[0].id, { maxPages: 10 })).length, streamId: st?.streamId ? 'YES' : 'no', keys: Object.keys(st || {}) } })
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
