// 钉死 1.4.0 两个断点的精确形状
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
  // 1. 新会话助手消息的原始 metadata（找 uuid 搬去哪了）
  const raw = await q('chats.listBySubChat', { subChatId: 'mvtdtob8nfwfbs70', limit: 10 })
  const msgs = (raw?.json ?? raw)?.messages || []
  const asst = msgs.find(x => x.role === 'assistant')
  const metaDump = asst ? { keys: Object.keys(asst.metadata || {}), full: JSON.stringify(asst.metadata || {}).slice(0, 400) } : null
  // 2. streamId 形状：空闲测试会话 vs 正在流式的开发会话
  const sdIdle = await q('chats.getSubChat', { id: 'mvtdtob8nfwfbs70' })
  const idleSid = (sdIdle?.json ?? sdIdle)?.streamId
  const devCid = E.currentChatId()
  const dd = await E.chatDetail(devCid)
  const devSub = (dd?.subChats || dd?.subs || [])[0]
  const sdDev = await q('chats.getSubChat', { id: devSub?.id })
  const devSid = (sdDev?.json ?? sdDev)?.streamId
  const shape = (v) => v === undefined ? 'undefined' : v === null ? 'null' : typeof v === 'string' ? 'str(' + v.slice(0, 16) + ')' : typeof v === 'object' ? 'obj keys=' + JSON.stringify(Object.keys(v || {})) : typeof v
  // 3. 老消息(开发会话)最后一条助手 vs 新会话：对比 metadata
  const devMsgs = await E.loadMessages(devSub?.id)
  const devAsst = devMsgs.filter(x => x.role === 'assistant').slice(-1)[0]
  const rawDev = await q('chats.listBySubChat', { subChatId: devSub?.id, limit: 200 })
  const rawDevMsgs = (rawDev?.json ?? rawDev)?.messages || []
  const rawLastAsst = rawDevMsgs.filter(x => x.role === 'assistant').slice(-1)[0]
  return JSON.stringify({
    newAsstMeta: metaDump,
    oldAsstMetaKeys: Object.keys(rawLastAsst?.metadata || {}),
    oldAsstSdkUuid: rawLastAsst?.metadata?.sdkMessageUuid || null,
    streamId: { idle: shape(idleSid), dev: shape(devSid) },
    prodMappingSees: { newAsstUuid: devAsst ? undefined : undefined, viaLoad: (await E.loadMessages('mvtdtob8nfwfbs70')).filter(x => x.role === 'assistant').map(x => ({ seq: x.sequence, uuid: x.sdkMessageUuid || null })) }
  }, null, 1)
})()`)
console.log(out)
ws.close()
process.exit(0)
