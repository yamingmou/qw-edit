// 探当前视图按钮状态
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const ev = (expr) => new Promise(res => {
  const id = ++i
  pend.set(id, res)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
})
const r = await ev(`(async()=>{
  const E = window.__qwEdit
  return JSON.stringify({
    chat: E.currentChatId(),
    userB: document.querySelectorAll('div[class*="container/user-message"]').length,
    asstB: document.querySelectorAll('div[class*="container/assistant-message"]').length,
    edit: document.querySelectorAll('.qw-edit-btn').length,
    regen: document.querySelectorAll('.qw-regen-btn').length,
    times: document.querySelectorAll('[data-qw-time]').length,
    bodyHasBeta: document.body.innerText.includes('BETA'),
    perUserBtn: [...document.querySelectorAll('div[class*="container/user-message"]')].map(b=>!!b.querySelector('.qw-edit-btn')),
    lastUserText: (([...document.querySelectorAll('div[class*="container/user-message"]')].slice(-1)[0]||{}).innerText||'').slice(0,40)
  })
})()`)
const v = r.result?.result?.value ?? r.result?.exceptionDetails
console.log(typeof v === 'string' ? v : JSON.stringify(v))
ws.close()
process.exit(0)
