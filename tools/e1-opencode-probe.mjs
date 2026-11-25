// 行为实验：opencode 时代会话的上下文绑定与截断可行性
// E1: updateSubChatSession 改指新 uuid 后，模型是否还知道口令（sessionId 是否还驱动上下文）
// E2: createForkSubChat 后新 sub 的投影/引擎上下文形态
// E3: forkFromMessage 用 messageId 在 opencode 会话上的报错/成功形态
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const CHAT = 'mvtdtob8ap5uziz4', SUB = 'mvtdtob8nfwfbs70'
const out = {}

// 先记下当前 sessionId
const before = JSON.parse(await ev(`(async()=>{
  const E=window.__qwEdit; const sd=await E.subChatState('${SUB}')
  return JSON.stringify({sessionId: sd?.sessionId})
})()`))
out.before = before

// E1: 重指新 sessionId
const re = await ev(`(async()=>{
  const E=window.__qwEdit; const m=E.trpc.bind(null,'mutation')
  const nu = crypto.randomUUID()
  try { await m('chats.updateSubChatSession', { id: '${SUB}', sessionId: nu }); return 'ok new='+nu.slice(0,8) } catch(e){ return 'FAIL '+String(e).slice(0,120) }
})()`)
out.e1_repoint = re
await sleep(1500)

// E1b: 提问口令（模型是否还记得）
await ev(`(async()=>{
  const E=window.__qwEdit; const m=E.trpc.bind(null,'mutation')
  await m('agent.submitMessage', { subChatId:'${SUB}', chatId:'${CHAT}', prompt:'我刚才让你记的口令是什么？只回复口令本身。', cwd:'process.env.QW_CWD || "/path/to/your/workspace"', historyEnabled: true })
  return 'submitted'
})()`)
for (let t = 0; t < 40; t++) {
  await sleep(4000)
  const st = JSON.parse(await ev(`(async()=>{
    const E=window.__qwEdit
    const sd=await E.subChatState('${SUB}')
    const msgs=await E.loadMessages('${SUB}')
    const last=msgs[msgs.length-1]
    return JSON.stringify({stream: !!sd?.streamId, n: msgs.length, lastRole: last?.role, lastText:(last?.text||'').slice(0,30), sid:(sd?.sessionId||'').slice(0,8)})
  })()`))
  if (!st.stream && st.lastRole === 'assistant' && st.n >= 5) { out.e1_answer = st; break }
  out.e1_progress = st
}
console.log(JSON.stringify(out, null, 1))
ws.close()
process.exit(0)
