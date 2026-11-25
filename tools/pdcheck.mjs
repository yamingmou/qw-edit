// 区分“过程不存在”与“参数校验错”：看完整错误文本
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 300)
  return r.result?.result?.value
}

const out = await ev(`(async () => {
  const T = window.__qwEdit.trpc
  const res = {}
  // A. 空 input：过程存在则报校验错；过程不存在则报 No procedure
  try { const x = await T('mutation', 'chats.permanentDelete', {}); res.empty = 'RESOLVED ' + JSON.stringify(x).slice(0, 60) }
  catch (e) { res.empty = String(e).slice(0, 220) }
  // B. 正确形状（假 id）
  try { const x = await T('mutation', 'chats.permanentDelete', { id: 'nonexistent-xyz' }); res.ids = 'RESOLVED ' + JSON.stringify(x).slice(0, 80) }
  catch (e) { res.ids = String(e).slice(0, 220) }
  // C. 对照：生产代码里实际调用的路径名
  return JSON.stringify(res, null, 1)
})()`)
console.log(out)
ws.close()
process.exit(0)
