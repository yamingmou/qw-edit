// 可见性 + 挂载延迟验证
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const r = await call('Runtime.evaluate', { expression: `(async()=>{
  const vis = document.visibilityState
  const start = Date.now()
  let idleFired = false
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { idleFired = true }, { timeout: 800 })
  await new Promise(r2 => setTimeout(r2, 2000))
  window.__qwEdit.scheduleMount()
  await new Promise(r2 => setTimeout(r2, 1500))
  return JSON.stringify({ vis, idleFired, waitedMs: Date.now() - start, edit: document.querySelectorAll('.qw-edit-btn').length })
})()`, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)))
ws.close()
process.exit(0)
