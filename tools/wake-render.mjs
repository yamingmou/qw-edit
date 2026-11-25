// 重载 + 唤醒 + 审计一步到位
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
await call('Page.enable')
await call('Page.reload')
await new Promise(r => setTimeout(r, 15000))
const expr = `(async () => {
  const E = window.__qwEdit
  if (!E) return 'NOT-INJECTED'
  const normT = (s) => (s||'').replace(/\\s+/g,' ').trim()
  const cands = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.x < 300 && r.width > 100 && normT(b.textContent) })
  const dev = cands.find(b => normT(b.textContent).includes('插件开发者'))
  const other = cands.find(b => !normT(b.textContent).includes('插件开发者') && !normT(b.textContent).includes('新任务') && !normT(b.textContent).includes('回收站') && !normT(b.textContent).includes('技能'))
  if (E.currentChatId() !== 'mvfhzb4t961plcac' && dev) { dev.click(); await new Promise(r2 => setTimeout(r2, 3000)) }
  if (!document.querySelectorAll('div[class*="container/assistant-message"]').length && other && dev) {
    other.click(); await new Promise(r2 => setTimeout(r2, 1500))
    dev.click(); await new Promise(r2 => setTimeout(r2, 4000))
  }
  return JSON.stringify({ chat: E.currentChatId(), asstB: document.querySelectorAll('div[class*="container/assistant-message"]').length, userB: document.querySelectorAll('div[class*="container/user-message"]').length })
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 200)))
ws.close()
process.exit(0)
