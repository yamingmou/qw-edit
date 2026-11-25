// 点开侧边栏「测试输入输出」→ 等渲染 → 截图
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1500) })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Page.enable')
await call('Runtime.enable')
const expr = `(async () => {
  const rows = [...document.querySelectorAll('[data-chat-item], aside button, nav button')].filter(r => (r.textContent || '').indexOf('测试输入输出') >= 0)
  if (!rows.length) return 'ROW-NOT-FOUND'
  const btn = rows[0].closest('button') || rows[0]
  btn.click()
  await new Promise(r => setTimeout(r, 2500))
  const bub = [...document.querySelectorAll('div[class*="container/user-message"] div[class*="whitespace-pre-wrap"]')].map(e => (e.textContent || '').slice(0, 30))
  return JSON.stringify({ clicked: true, url: location.search.slice(0, 80), userBubbles: bub })
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 })
console.log(r.result && r.result.value)
await new Promise(res => setTimeout(res, 1200))
const s = await call('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('tools/out-shot2.png', Buffer.from(s.result.data, 'base64'))
console.log('shot2 saved', fs.statSync('tools/out-shot2.png').size)
ws.close()
process.exit(0)
