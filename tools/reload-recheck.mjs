// 强制重载后复查挂载
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
await call('Page.enable')
await call('Page.reload', { ignoreCache: false })
await new Promise(r => setTimeout(r, 12000))
const r = await call('Runtime.evaluate', { expression: `(async()=>{
  const E = window.__qwEdit
  if (!E) return 'NOT-INJECTED'
  return JSON.stringify({
    edit: document.querySelectorAll('.qw-edit-btn').length,
    regen: document.querySelectorAll('.qw-regen-btn').length,
    times: document.querySelectorAll('[data-qw-time]').length,
    userB: document.querySelectorAll('div[class*="container/user-message"]').length
  })
})()`, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 200)))
ws.close()
process.exit(0)
