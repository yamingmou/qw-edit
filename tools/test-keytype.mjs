// 最忠实模拟：新任务视图 → 逐字符可信键盘输入 → 可信 Enter → 轮询落库 → 截图存证
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '键验' + Math.random().toString(36).slice(2, 6)
const TEXT = MARK + '。只回复：收到'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expression, ap = true) => {
  try {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
    const inner = r.result && r.result.result
    if (inner && 'value' in inner) return inner.value
    const ex = r.result && r.result.exceptionDetails
    return ex ? 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 140) : 'NOVAL'
  } catch (e) { return 'TO:' + String(e).slice(0, 60) }
}
await call('Runtime.enable')
await call('Input.enable').catch(() => {})
// 1. 新任务视图
console.log('nav:', await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x => !(x.closest('li')||x.closest('[data-chat-item]')) && /新任务/.test(x.textContent||'')); if (b) b.click(); return b?'NAV':'NO-NAV' })()`, false))
await sleep(2500)
// 2. 真实鼠标点 composer 中央（拿当前坐标立刻点，避免时移）
const cpos = await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); if (!el) return 'NO-EDITOR'; const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+Math.min(30,r.width/2), y:r.y+Math.min(20,r.height/2)}) })()`, false)
console.log('composer:', cpos)
if (cpos && cpos.startsWith('{')) {
  const { x, y } = JSON.parse(cpos)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
await sleep(600)
// 3. 逐字符可信键盘输入
for (const ch of TEXT) {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
  await call('Input.dispatchKeyEvent', { type: 'keyUp' })
}
console.log('typed:', TEXT.length, 'chars; dom now:', await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); return (el.value || el.textContent || '').slice(0, 20) })()`, false))
await sleep(500)
// 4. 可信 Enter 发送
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('enter sent')
// 5. 轮询落库
let ok = false
for (let k = 0; k < 25; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
    const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
    for (const c of chats.slice(0, 8)) {
      const det = await E.trpc('query', 'chats.get', { id: c.id })
      const dd = (det && det.json) ? det.json : det
      const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
      for (const s of subs) {
        const all = await E.loadMessages(s.id, { maxPages: 3 })
        if (all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0)) return JSON.stringify({ chat: c.id, n: all.length })
      }
    }
    return 'NOT-YET'
  })()`)
  console.log('poll', k, r)
  if (r && r.startsWith('{')) { ok = true; break }
}
console.log(ok ? 'PASS: 逐字符键盘路径发送成功' : 'FAIL: 逐字符键盘也没发出去')
const s = await call('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('tools/out-shot3.png', Buffer.from(s.result.data, 'base64'))
ws.close()
process.exit(ok ? 0 : 1)
