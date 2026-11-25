// 最小 CDP 连接测试
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
console.log('targets:', list.length, list.map(t => t.type + ':' + (t.url || '').slice(0, 60)))
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const r = await call('Runtime.evaluate', { expression: 'JSON.stringify({href: location.href.slice(0,80), qw: !!window.__qwEdit, btns: document.querySelectorAll("[class*=user-message]").length})', returnByValue: true })
console.log('RAW:', JSON.stringify(r).slice(0, 600))
ws.close()
process.exit(0)
