// 裸调挂载函数，让真实异常现形
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const expr = `(async()=>{
  const E = window.__qwEdit
  const errs = []
  // 从闭包外无法直接调 mountButtons，但可调导出的 scheduleMount + 观察 console.warn
  const ow = console.warn; const caps = []
  console.warn = (...a) => { caps.push(a.map(String).join(' ').slice(0, 200)); ow.apply(console, a) }
  E.scheduleMount()
  await new Promise(r => setTimeout(r, 1200))
  console.warn = ow
  return JSON.stringify({ captured: caps, edit: document.querySelectorAll('.qw-edit-btn').length,
    btn: (typeof document.querySelector('.qw-edit-btn')), times: document.querySelectorAll('[data-qw-time]').length })
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)))
ws.close()
process.exit(0)
