// E3: opencode 会话上 forkFromMessage(messageId) 截断分叉的行为验证
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
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400)
  return r.result?.result?.value
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const CHAT = 'mvtdtob8ap5uziz4', SUB = 'mvtdtob8nfwfbs70'
const out = {}

// 现状消息（E1 后应有 4 条）
out.msgs0 = JSON.parse(await ev(`(async()=>{
  const E=window.__qwEdit; const msgs=await E.loadMessages('${SUB}')
  return JSON.stringify(msgs.map(x=>({id:x.messageId, role:x.role, seq:x.sequence, t:(x.text||'').slice(0,14)})))
})()`))

// 加一轮（BETA77 第二口令）
await ev(`(async()=>{
  const E=window.__qwEdit; const m=E.trpc.bind(null,'mutation')
  await m('agent.submitMessage',{subChatId:'${SUB}',chatId:'${CHAT}',prompt:'再记一个第二口令 BETA77，只回复：收到。',cwd:'process.env.QW_CWD || "/path/to/your/workspace"',historyEnabled:true})
  return 'ok'
})()`)
for (let t = 0; t < 30; t++) {
  await sleep(4000)
  const s = JSON.parse(await ev(`(async()=>{const E=window.__qwEdit;const sd=await E.subChatState('${SUB}');const msgs=await E.loadMessages('${SUB}');return JSON.stringify({n:msgs.length,stream:!!sd?.streamId})})()`))
  if (s.n >= 6 && !s.stream) break
}
out.msgs1 = JSON.parse(await ev(`(async()=>{const E=window.__qwEdit;const msgs=await E.loadMessages('${SUB}');return JSON.stringify(msgs.map(x=>({id:x.messageId,role:x.role,seq:x.sequence,t:(x.text||'').slice(0,14)})))})()`))

// 取第一轮助手回答的 messageId（seq 最小的 assistant）
const anchorId = out.msgs1.filter(x => x.role === 'assistant').sort((a, b) => a.seq - b.seq)[0]?.id
out.anchorId = anchorId

// forkFromMessage 截断分叉
const forkRes = await ev(`(async()=>{
  const E=window.__qwEdit; const m=E.trpc.bind(null,'mutation')
  try { const r=await m('chats.forkFromMessage',{chatId:'${CHAT}',subChatId:'${SUB}',messageId:'${anchorId}'}); return 'OK '+JSON.stringify(r?.json ?? r).slice(0,300) }
  catch(e){ return 'FAIL '+String(e).slice(0,300) }
})()`)
out.fork = forkRes
console.log(JSON.stringify(out, null, 1))
ws.close()
process.exit(0)
