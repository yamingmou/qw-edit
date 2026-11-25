// 查失败测试会话现状
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
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 250)
  return r.result?.result?.value
}
const out = await ev(`(async () => {
  const E = window.__qwEdit
  const q = E.trpc.bind(null, 'query')
  const det = await E.chatDetail('mvtdtob8ap5uziz4')
  const subs = det?.subChats || det?.subs || []
  const res = { subCount: subs.length, subs: subs.map(s => ({ id: s.id, mode: s.mode, sessionId: (s.sessionId || s.sdkSessionId || '').slice(0, 12) })) }
  if (subs.length) {
    const msgs = await E.loadMessages(subs[0].id)
    res.msgs = msgs.map(x => ({ role: x.role, seq: x.sequence, uuid: !!x.sdkMessageUuid, text: (x.text || '').slice(0, 30) }))
    const sd = await E.subChatState(subs[0].id)
    res.state = sd ? Object.keys(sd).reduce((a, k) => { const v = sd[k]; a[k] = typeof v === 'object' ? '[obj]' : String(v).slice(0, 40); return a }, {}) : null
    // 原始 getSubChat（看 1.4.0 字段全貌）
    const rawSd = await q('chats.getSubChat', { id: subs[0].id })
    res.rawKeys = Object.keys((rawSd?.json ?? rawSd) || {})
  }
  return JSON.stringify(res, null, 1)
})()`)
console.log(out)
ws.close()
process.exit(0)
