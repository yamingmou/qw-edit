// 截取当前窗口截图到 tools/out-shot.png
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1500) })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Page.enable')
const r = await call('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('tools/out-shot.png', Buffer.from(r.result.data, 'base64'))
console.log('shot saved bytes:', fs.statSync('tools/out-shot.png').size)
ws.close()
process.exit(0)
