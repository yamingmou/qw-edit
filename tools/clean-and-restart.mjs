// 清理：删除侧边栏里所有 n==0 的无名会话（自动化产生的空壳）；然后延迟 SIGKILL 客户端并带端口重开
import { execFile } from 'node:child_process'
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
const expr = `(async () => {
  const E = window.__qwEdit
  let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
  const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
  const doomed = []
  for (const c of chats) {
    const nm = (c.name || '').trim()
    if (nm !== '新任务' && nm !== '') continue
    try {
      const det = await E.trpc('query', 'chats.get', { id: c.id })
      const dd = (det && det.json) ? det.json : det
      const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
      let n = 0
      for (const s of subs) { const all = await E.loadMessages(s.id, { maxPages: 2 }); n += all.length }
      if (n === 0) doomed.push({ id: c.id, name: nm || '未命名' })
    } catch {}
  }
  if (!doomed.length) return 'NO-EMPTY-SHELLS'
  const cnt = await E.permanentDeleteChats(doomed, { skipConfirm: true })
  return 'PURGED ' + cnt + ' of ' + JSON.stringify(doomed.map(d => d.id))
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log('cleanup:', r.result && r.result.value)
try { ws.close() } catch {}
// 延迟重启客户端（给本条回复送达留时间）
await sleep(6000)
execFile('/bin/sh', ['-c', 'pkill -x QwenWorkCN; sleep 2; open -a QwenWorkCN --args --remote-debugging-port=9222'], () => {})
console.log('restart scheduled')
process.exit(0)
