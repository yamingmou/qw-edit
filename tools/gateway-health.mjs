// 网关健康检查：建会话→提交→等回答→dump 每条消息的 role/status/text
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1500) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const ev = async (expression, ap = true) => {
  try {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
    const inner = r.result && r.result.result
    if (inner && 'value' in inner) return inner.value
    const ex = r.result && r.result.exceptionDetails
    return 'EX:' + JSON.stringify(ex ? (ex.exception?.description || ex.text) : r).slice(0, 200)
  } catch (e) { return 'TO:' + String(e).slice(0, 80) }
}
const R = '康检' + Math.random().toString(36).slice(2, 6)
const created = await ev(`(async () => {
  const E = window.__qwEdit
  const home = await E.chatDetail('mvfhzb4t961plcac')
  const pid = home.chat && (home.chat.projectId || home.chat.localProjectId)
  const c = await E.trpc('mutation', 'chats.create', { projectId: pid })
  const cc = (c && c.json) ? c.json : c
  const cid = cc && (cc.id || (cc.chat && cc.chat.id))
  if (!cid) return 'NOID'
  const d = await E.chatDetail(cid)
  return JSON.stringify({ cid, sid: d.subs[0] && d.subs[0].id })
})()`)
console.log('create:', created)
if (!created.startsWith('{')) process.exit(1)
const { cid, sid } = JSON.parse(created)
console.log('submit:', await ev(`(async () => {
  const E = window.__qwEdit
  try { const r = await E.apiSubmit({ subChatId: ${JSON.stringify(sid)}, chatId: ${JSON.stringify(cid)}, prompt: ${JSON.stringify(R + '。说一个字：好')}, cwd: '', mode: 'agent' }); return 'OK:' + JSON.stringify(r).slice(0, 80) } catch (e) { return 'ERR:' + String(e.message || e).slice(0, 120) }
})()`))
for (let k = 0; k < 14; k++) {
  await sleep(5000)
  const st = await ev(`(async () => {
    const E = window.__qwEdit
    const all = await E.loadMessages(${JSON.stringify(sid)}, { maxPages: 3 })
    const s = await E.subChatState(${JSON.stringify(sid)})
    return JSON.stringify({ n: all.length, busy: !!(s && s.streamId), rows: all.map(x => x.role[0] + '/' + (x.status || '?') + '/' + (x.text || '').slice(0, 14)) })
  })()`)
  console.log('t+' + (k * 5) + 's:', st)
  if (st && st.includes('/completed/') && !st.includes('"busy":true')) break
}
console.log('cleanup:', await ev(`(async () => { try { return 'PURGED=' + await window.__qwEdit.permanentDeleteChats([{ id: ${JSON.stringify(cid)}, name: '${R}' }], { skipConfirm: true }) } catch (e) { return 'FAIL' } })()`))
ws.close()
process.exit(0)
