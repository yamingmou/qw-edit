// 长会话时间戳对齐正确性：DOM 气泡显示的时间 vs 按文本匹配的真实消息时间
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const expr = `(async () => {
  const E = window.__qwEdit
  // 唤醒渲染：点去别的会话再点回
  const dev = E.sidebarItemsByName('插件开发者')[0]
  const allRows = [...document.querySelectorAll('div[class*="sidebar"], nav, aside')].flatMap(() => [])
  const cands = [...document.querySelectorAll("button")].filter(b => { const r = b.getBoundingClientRect(); return r.x < 300 && r.width > 100 && normText(b.textContent) })
  function normText(s){ return (s||'').replace(/\s+/g,' ').trim() }
  const other = cands.find(b => !normText(b.textContent).includes('插件开发者') && !normText(b.textContent).includes('新任务') && !normText(b.textContent).includes('回收站'))
  if (other) { other.click(); await new Promise(r2 => setTimeout(r2, 1500)) }
  if (dev) { dev.click(); await new Promise(r2 => setTimeout(r2, 4000)) }
  const det = await E.chatDetail(E.currentChatId())
  const subs = det.subChats ?? det.subs ?? []
  const sub = subs[0]
  const all = await E.loadMessages(sub.id, { maxPages: 1 })
  const assists = all.filter(x => x.role === 'assistant').sort((a, b) => a.sequence - b.sequence)
  const fmt = (t) => { try { const d = new Date(t); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') } catch { return '?' } }
  const rows = []
  document.querySelectorAll('div[class*="container/assistant-message"]').forEach((b, idx) => {
    const shown = b.querySelector('[data-qw-time]')?.textContent || '(无)'
    const txt = (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24)
    const byPos = assists[idx]
    const byText = assists.find(a => txt && (a.text || '').replace(/\\s+/g, ' ').trim().startsWith(txt.slice(0, 18)))
    rows.push({ idx, shown, posTime: byPos ? fmt(byPos.createdAt) : '-', posText: (byPos?.text || '').slice(0, 14), textMatchTime: byText ? fmt(byText.createdAt) : '-', textMatchOk: byText ? (fmt(byText.createdAt) === shown.replace(/[^\d:]/g, '')) : null, bubbleText: txt.slice(0, 14) })
  })
  return JSON.stringify({ total: all.length, assists: assists.length, rows: rows.slice(0, 8) }, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300), null, 1))
ws.close()
process.exit(0)
