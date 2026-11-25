// 清理本轮调查产生的一次性会话（软删→彻底删，按 id，不动视图）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const expr = `(async () => {
  const m = window.__qwEdit.trpc.bind(null, 'mutation')
  const res = {}
  for (const cid of ['mvtdtob8ap5uziz4', 'mvteh4bi9cj087o3']) {
    try { await m('chats.delete', { id: cid }); await m('chats.permanentDelete', { id: cid }); res[cid] = 'purged' }
    catch (e) { res[cid] = String(e).slice(0, 80) }
  }
  return JSON.stringify(res)
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)))
ws.close()
process.exit(0)
