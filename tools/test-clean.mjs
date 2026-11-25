// 干净实验：切到已有会话「测试输入输出」→ 可信点击 composer → 可信键入 → elementFromPoint 校验 → 可信点击发送 → 轮询
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MARK = '清验' + Math.random().toString(36).slice(2, 6)
const TEXT = MARK + '。只回复：收到'
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
let ws = new WebSocket(page.webSocketDebuggerUrl)
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
// 0. 前置断言：当前视图会话必须空闲（streamId 为空）——1.4.0 实测：任何会话的发送在"有任务运行"时会被排队
const busy0 = await ev(`(async () => {
  const E = window.__qwEdit
  const cid = new URLSearchParams(location.search).get('chat')
  const d = await E.chatDetail(cid)
  for (const s of d.subs) { const st = await E.subChatState(s.id); if (st && st.streamId) return 'BUSY-HERE' }
  return 'IDLE-HERE'
})()`)
console.log('pre:', busy0)
// 1. 侧边栏点开已有会话
console.log('open:', await ev(`(() => {
  const rows = [...document.querySelectorAll('[data-chat-item], aside [class*=cursor-pointer], [data-sidebar] button')]
  const t = rows.find(r => (r.textContent || '').indexOf('测试输入输出') >= 0)
  if (!t) return 'ROW-NOT-FOUND'
  ;(t.closest('button') || t).click(); return 'OPENED'
})()`, false))
await sleep(2500)
console.log('url:', await ev(`location.search.slice(0, 80)`, false))
// 导航硬校验：必须落在测试输入输出（mvtdg8uqoh2gsq7n），否则官方导航重载 + 重连
const TARGET = 'mvtdg8uqoh2gsq7n'
let cur = await ev(`new URLSearchParams(location.search).get('chat')`, false)
if (cur !== TARGET) {
  console.log('nav-fallback: openMainWindowWithChat')
  await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(TARGET)} })`, false).catch(() => {})
  await sleep(6000)
  try { ws.close() } catch {}
  await new Promise(r => setTimeout(r, 2000))
  const l2 = await (await fetch('http://127.0.0.1:9222/json')).json()
  const pg2 = l2.find(t => t.type === 'page' && t.url.includes('index.html'))
  const ws2 = new WebSocket(pg2.webSocketDebuggerUrl)
  await new Promise(r => { ws2.onopen = r; setTimeout(r, 1500) })
  ws = ws2
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  await call('Runtime.enable')
  cur = await ev(`new URLSearchParams(location.search).get('chat')`, false)
  console.log('after nav:', cur)
  if (cur !== TARGET) { console.log('FAIL: 无法导航到目标会话'); process.exit(1) }
}
// 2. 可信点击 composer 并键入
const cpos = await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); if (!el) return 'NO-EDITOR'; const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+40, y:r.y+Math.min(16,r.height/2)}) })()`, false)
console.log('composer:', cpos)
if (cpos && cpos.startsWith('{')) {
  const { x, y } = JSON.parse(cpos)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
await sleep(500)
// 2.5 全选清空残留草稿（可信事件），再键入
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
await sleep(200)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
await sleep(400)
console.log('cleared:', await ev(`(() => { const el=document.querySelector("[contenteditable='true'], textarea:not([readonly])"); return JSON.stringify((el.value || el.textContent || '').slice(0, 20)) })()`, false))
for (const ch of TEXT) {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
  await call('Input.dispatchKeyEvent', { type: 'keyUp' })
}
await sleep(600)
// 3. 按钮坐标 + 顶层元素校验 + 焦点
const chk = await ev(`(() => {
  const sb = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').match(/发送|send|提交/i))
  if (!sb) return JSON.stringify({ err: 'no-btn' })
  const r = sb.getBoundingClientRect()
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const top = document.elementFromPoint(cx, cy)
  const el = document.querySelector("[contenteditable='true'], textarea:not([readonly])")
  return JSON.stringify({ at: [Math.round(cx), Math.round(cy)], dis: !!sb.disabled, topIsBtn: sb.contains(top) || top === sb, topTag: top ? top.tagName + '.' + String(top.className).slice(0, 24) : null, hasFocus: document.hasFocus(), dom: (el.value || el.textContent || '').slice(0, 20) })
})()`, false)
console.log('pre-click:', chk)
// 4. 可信点击发送
const at = JSON.parse(chk).at
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', clickCount: 1 })
console.log('clicked send')
// 5. 轮询该会话
let ok = false
for (let k = 0; k < 20; k++) {
  await sleep(3000)
  const r = await ev(`(async () => {
    const E = window.__qwEdit
    const cid = new URLSearchParams(location.search).get('chat')
    const d = await E.chatDetail(cid)
    for (const s of d.subs) {
      const all = await E.loadMessages(s.id, { maxPages: 3 })
      if (all.some(x => (x.text || '').indexOf(${JSON.stringify(MARK)}) === 0)) return JSON.stringify({ n: all.length, done: all.some(x => x.role === 'assistant' && x.status === 'completed') })
    }
    return 'NOT-YET'
  })()`)
  console.log('poll', k, r)
  if (r && r.startsWith('{')) { ok = true; break }
}
console.log(ok ? 'PASS: 已有会话可信发送成功' : 'FAIL: 已有会话也发不出去')
ws.close()
process.exit(ok ? 0 : 1)
