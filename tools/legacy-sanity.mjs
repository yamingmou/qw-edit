// legacy 完整性：开发会话翻页加载 vs 原始量 + 锚点可用性 + era-guard 不误伤
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
  // 先回开发会话（当前停在测试会话）
  const row = E.sidebarItemsByName('插件开发者')[0]
  if (row) { row.click(); await new Promise(r2 => setTimeout(r2, 2000)) }
  const cid = E.currentChatId()
  const det = await E.chatDetail(cid)
  const subs = det.subChats ?? det.subs ?? []
  const active = subs.find(s => s.id) || subs[0]
  const all = await E.loadMessages(active.id)
  const seqs = all.map(x => x.sequence)
  const mono = seqs.every((v, idx) => idx === 0 || v > seqs[idx - 1])
  const lastUser = [...all].reverse().find(x => x.role === 'user')
  // 用生产同款锚点函数语义在页外复算（anchorBefore 未导出，直接等价计算）
  const cands = all.filter(x => x.role === 'assistant' && x.sdkMessageUuid && x.sequence < lastUser.sequence)
  const anchor = cands.filter(x => x.status === 'completed').slice(-1)[0] ?? cands.slice(-1)[0] ?? null
  // 原始单页对照（limit 200 拿到的条数 vs 翻页后总数）
  const raw = await E.trpc('query', 'chats.listBySubChat', { subChatId: active.id, limit: 200 })
  const rawN = ((raw?.json ?? raw)?.messages ?? []).length
  return JSON.stringify({ sub: active.id.slice(0, 8), total: all.length, rawN, mono,
    seqMin: seqs[0], seqMax: seqs[seqs.length - 1],
    lastUserSeq: lastUser.sequence, anchorFound: !!anchor, anchorUuid: !!anchor?.sdkMessageUuid })
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)))
ws.close()
process.exit(0)
