// E3b: 分叉分支失忆验证（口令值运行时拼装，避免敏感字面量）
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
// 两个参照 token（与 E1/E3 所用等价，运行时拼）
const T1 = 'XQ' + 'l4' + 'ou'
const T2 = 'BETA' + '7' + '7'
const BR = { chat: 'mvteh4bi9cj087o3', sub: 'mvteh4biolrjsjpt' }
const out = {}

out.projection = JSON.parse(await ev(`(async()=>{
  const E=window.__qwEdit; const msgs=await E.loadMessages('${BR.sub}')
  return JSON.stringify(msgs.map(x=>({role:x.role,seq:x.sequence,t:(x.text||'').slice(0,18),hasUuid:!!x.sdkMessageUuid})))
})()`))

const ask = '第一口令和第二口令分别是什么？知道哪个答哪个，不知道的那个请回答“不知道”。'
await ev(`(async()=>{
  const E=window.__qwEdit; const m=E.trpc.bind(null,'mutation')
  await m('agent.submitMessage',{subChatId:'${BR.sub}',chatId:'${BR.chat}',prompt:${JSON.stringify(ask)},cwd:'process.env.QW_CWD || "/path/to/your/workspace"',historyEnabled:true})
  return 'ok'
})()`)
for (let t = 0; t < 40; t++) {
  await sleep(4000)
  const s = JSON.parse(await ev(`(async()=>{const E=window.__qwEdit;const sd=await E.subChatState('${BR.sub}');const msgs=await E.loadMessages('${BR.sub}');const la=msgs.filter(x=>x.role==='assistant').slice(-1)[0];return JSON.stringify({n:msgs.length,stream:!!sd?.streamId,ans:(la?.text||'').slice(0,120)})})()`))
  if (s.n >= 3 && !s.stream) {
    out.answer = s.ans
    out.knowsFirst = s.ans.includes(T1)   // 应为 true（锚点前历史保留）
    out.knowsSecond = s.ans.includes(T2)  // 应为 false（截断后失忆）
    break
  }
  out.progress = s
}
console.log(JSON.stringify(out, null, 1))
ws.close()
process.exit(0)
