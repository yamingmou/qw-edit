// DB 权威验证：2026-10-29 18:03(本地)=10:03Z 的助手消息是否存在且内容吻合
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m) }
}
const ev = (expr) => new Promise(res => {
  const id = ++i
  pend.set(id, res)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
})
const r = await ev(`(async()=>{
  const E = window.__qwEdit
  const det = await E.chatDetail(E.currentChatId())
  const sub = (det.subChats ?? det.subs ?? [])[0]
  const all = await E.loadMessages(sub.id)
  const cands = all
    .filter(x => x.role === 'assistant' && x.createdAt && new Date(x.createdAt).getTime() >= Date.parse('2026-10-29T10:03:00Z') && new Date(x.createdAt).getTime() <= Date.parse('2026-10-29T10:03:30Z'))
    .map(x => ({ seq: x.sequence, t: new Date(x.createdAt).toLocaleString('zh-CN'), head: (x.text || '').replace(/\\s+/g, ' ').slice(0, 20) }))
  return JSON.stringify(cands)
})()`)
console.log(r.result?.result?.value ?? JSON.stringify(r.result?.exceptionDetails)?.slice(0, 200))
ws.close()
process.exit(0)
