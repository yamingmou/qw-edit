// 解剖 composer 编辑器：元素 keys、fiber 上的 props/state、识别框架（Lexical/Slate/自定义）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 1200) })
let i = 0
const p2 = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
await call('Runtime.enable')
const expr = `(() => {
  const el = document.querySelector("[contenteditable='true']")
  if (!el) return 'NO-EDITOR'
  const keys = Object.keys(el)
  const fiberKey = keys.find(k => k.startsWith('__reactFiber$'))
  const propsKey = keys.find(k => k.startsWith('__reactProps$'))
  const props = propsKey ? el[propsKey] : null
  // 沿 fiber 向上找带 value/text/state 的组件
  let f = fiberKey ? el[fiberKey] : null
  const chain = []
  for (let d = 0; f && d < 14; d++) {
    const name = typeof f.type === 'function' ? (f.type.name || 'anon') : (f.type === null ? 'null' : String(f.type))
    let memo = ''
    try { if (f.memoizedProps) memo = Object.keys(f.memoizedProps).filter(k => /value|text|draft|onChange|onInput|send/i.test(k)).map(k => k + '=' + String(typeof f.memoizedProps[k] === 'function' ? 'fn' : f.memoizedProps[k]).slice(0, 18)).join(',') } catch {}
    chain.push(name + (memo ? ' [' + memo.slice(0, 90) + ']' : ''))
    f = f.return
  }
  return JSON.stringify({
    ownKeys: keys.filter(k => !k.startsWith('__react')).slice(0, 12),
    lexical: !!(el.__lexicalEditor || el._lexicalEditor),
    attrs: { role: el.getAttribute('role'), id: el.id, cls: String(el.className).slice(0, 60) },
    propsHandlers: props ? Object.keys(props).filter(k => /^on[A-Z]/.test(k)) : null,
    propsValue: props && props.value != null ? String(props.value).slice(0, 30) : (props && props.defaultValue != null ? String(props.defaultValue).slice(0, 30) : null),
    chain
  })
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
