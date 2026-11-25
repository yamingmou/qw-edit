// 验证 loadMessages 分页语义 + v9.31 已加载 + 拒绝对话形态探测
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}, timeout = 45000) => new Promise((res, rej) => {
  const i = ++id
  const t = setTimeout(() => rej(new Error('timeout')), timeout)
  pend.set(i, r => { clearTimeout(t); res(r) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300)
  return r.result?.result?.value
}
const out = await ev(`(async () => {
  const E = window.__qwEdit
  const q = E.trpc.bind(null, 'query')
  const SUB = 'mvtdtob8nfwfbs70' // 测试会话（opencode 时代，8 条）
  const p1 = await q('chats.listBySubChat', { subChatId: SUB, limit: 3 })
  const msgs1 = (p1?.json ?? p1)?.messages ?? []
  const p2 = await q('chats.listBySubChat', { subChatId: SUB, limit: 3, beforeSequence: Math.min(...msgs1.map(x=>x.sequence)) })
  const msgs2 = (p2?.json ?? p2)?.messages ?? []
  return JSON.stringify({
    ver: (window.__qwEdit ? 'injected' : 'MISSING'),
    page1_seqs: msgs1.map(x=>x.sequence),
    page2_seqs: msgs2.map(x=>x.sequence),
    loadAll_via_paginator: (await E.loadMessages(SUB)).map(x=>x.sequence),
    anchors_present: (await E.loadMessages(SUB)).filter(x=>x.role==='assistant'&&x.sdkMessageUuid).length
  })
})()`)
console.log(out)
ws.close()
process.exit(0)
