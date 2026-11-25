// 枚举所有"发送"相关按钮：位置、可见性、所在容器
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
  const hits = [...document.querySelectorAll('button')]
    .map((b, idx) => ({ idx, label: b.getAttribute('aria-label') || '', text: (b.textContent || '').trim().slice(0, 10), dis: !!b.disabled, r: b.getBoundingClientRect() }))
    .filter(x => /发送|send|提交/i.test(x.label) || x.text === '')
    .filter(x => /发送|send|提交/i.test(x.label))
    .map(x => ({ label: x.label, dis: x.dis, x: Math.round(x.r.x), y: Math.round(x.r.y), w: Math.round(x.r.width), vis: x.r.width > 0 && x.r.height > 0,
      parentCls: String(x.parentCls || (document.querySelectorAll('button')[0] && '') || '').slice(0, 0),
      path: (() => { let el = null; const bs = [...document.querySelectorAll('button')]; for (const b of bs) { if ((b.getAttribute('aria-label') || '') === x.label && Math.round(b.getBoundingClientRect().x) === x.x) { el = b; break } } let p = el, chain = []; while (p && chain.length < 4) { chain.push(p.tagName + '.' + String(p.className).split(' ').slice(0, 2).join('.')); p = p.parentElement } return chain.join(' < ').slice(0, 140) })() }))
  return JSON.stringify({ innerH: innerHeight, innerW: innerWidth, hits })
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
const inner = r.result && r.result.result
console.log(inner && inner.value ? inner.value : JSON.stringify(r).slice(0, 400))
ws.close()
process.exit(0)
