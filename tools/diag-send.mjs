// 诊断：原样执行 sendNow 表达式，打印 CDP 原始响应 + composer 现场
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1500) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `(() => {
  const btns = [...document.querySelectorAll('button')]
  const sb = btns.find(b => (b.getAttribute('aria-label') || '').match(/发送|send|提交/i))
    || btns.find(b => b.type === 'submit' && b.closest('form'))
    || btns.find(b => b.querySelector('svg') && /rounded-full/.test(b.className) && b.getBoundingClientRect().x > innerWidth * 0.5 && b.getBoundingClientRect().y > innerHeight * 0.6)
  if (sb) { sb.click(); return 'SENT-BTN:' + (sb.getAttribute('aria-label') || sb.className.slice(0, 30)) }
  const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  if (el) { el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return 'SENT-ENTER' }
  return 'NO-SEND'
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log('RAW:', JSON.stringify(r).slice(0, 600))
// 现场：composer 文本、按钮清单
const st = await call('Runtime.evaluate', { expression: `(() => {
  const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  const btns = [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '?').slice(0, 14) + (b.disabled ? '-off' : '')).slice(0, 40)
  return JSON.stringify({ composer: el ? (el.value || el.textContent || '').slice(0, 40) : 'NONE', btns })
})()`, returnByValue: true })
console.log('STATE:', st.result && st.result.value)
ws.close()
process.exit(0)
