// 诊断 1.4.0 composer：元素类型、fillComposer 后 React 内部状态是否收到文本、发送按钮 disabled 实况
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `(async () => {
  const out = {}
  // 1. 页面上所有候选输入元素
  out.cands = [...document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable]")]
    .map(el => ({ tag: el.tagName, ce: el.getAttribute('contenteditable'), ro: el.readOnly, ph: (el.getAttribute('placeholder') || '').slice(0, 12), vis: !!(el.offsetWidth || el.offsetHeight), val: (el.value || el.textContent || '').slice(0, 24) }))
  // 2. 当前 composer（我们选择器命中的第一个）
  const el = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  out.picked = el ? { tag: el.tagName, val: (el.value || el.textContent || '').slice(0, 30) } : null
  // 3. React 内部：value tracker 与 fiber props
  if (el && el.tagName === 'TEXTAREA') {
    const key = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$'))
    const props = key && el[key] && el[key].memoizedProps ? el[key].memoizedProps : (key ? el[key] : null)
    out.fiberKey = key || 'none'
    try { out.reactVal = props && props.value != null ? String(props.value).slice(0, 30) : (props && props.onChange ? 'hasOnNoVal' : 'no-props') } catch (e) { out.reactVal = 'ERR' }
    const tracker = el._valueTracker
    out.trackerVal = tracker ? String(tracker.getValue()).slice(0, 30) : 'none'
  }
  // 4. 发送按钮状态
  const sb = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').match(/发送|send|提交/i))
  out.sendBtn = sb ? { label: sb.getAttribute('aria-label'), disabled: !!sb.disabled, cls: (sb.className || '').slice(0, 40) } : 'NOT-FOUND'
  // 5. 实验：模拟真实键入一个字符（input 事件带 data），看 tracker/react 是否更新
  if (el && el.tagName === 'TEXTAREA') {
    const before = el.value
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, before + 'X')
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'X', inputType: 'insertText' }))
    await new Promise(r => setTimeout(r, 400))
    out.afterInput = { val: el.value.slice(-6), tracker: el._valueTracker ? String(el._valueTracker.getValue()).slice(-6) : 'none', btnOff: sb ? !!sb.disabled : null }
  }
  return JSON.stringify(out)
})()`
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r).slice(0, 500))
ws.close()
process.exit(0)
