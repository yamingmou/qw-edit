// 验证 agent.submitMessage API 通道在 1.4.0 空闲会话可用（测试输入输出）
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = 'API验' + Math.random().toString(36).slice(2, 6)
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const ev = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const inner = r.result && r.result.result
  if (inner && 'value' in inner) return inner.value
  const ex = r.result && r.result.exceptionDetails
  return 'EX:' + JSON.stringify(ex ? (ex.exception?.description || ex.text) : r).slice(0, 200)
}
const submit = await ev(`(async () => {
  const E = window.__qwEdit
  const cid = 'mvtdg8uqoh2gsq7n'
  const d = await E.chatDetail(cid)
  const sub = d.subs[0]
  const cwd = (d.chat && d.chat.worktreePath) || (d.chat && d.chat.project && d.chat.project.path) || (d.chat && d.chat.outputDirectory) || ''
  try {
    const r = await E.trpc('mutation', 'agent.submitMessage', { subChatId: sub.id, chatId: cid, prompt: ${JSON.stringify(MARK + '。只回复：收到')}, cwd, mode: sub.mode || 'agent' })
    return 'OK ' + JSON.stringify(r).slice(0, 120) + ' cwd=' + cwd
  } catch (e) { return 'ERR ' + String(e.message || e).slice(0, 200) }
})()`)
console.log('submit:', submit)
let ok = false
for (let k = 0; k < 20; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    const d = await E.chatDetail('mvtdg8uqoh2gsq7n')
    const all = await E.loadMessages(d.subs[0].id, { maxPages: 3 })
    const has = all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0)
    const done = all.some(x => x.role === 'assistant' && x.status === 'completed' && x.sequence > (all.find(y => (y.text || '').indexOf(${JSON.stringify(MARK)}) === 0)?.sequence ?? 1e9))
    return JSON.stringify({ n: all.length, has, done })
  })()`)
  console.log('poll', k, r)
  if (r && r.includes('"has":true')) { ok = true; if (r.includes('"done":true')) break }
}
console.log(ok ? 'PASS: API 通道可用' : 'FAIL: API 通道不通')
ws.close()
process.exit(ok ? 0 : 1)
