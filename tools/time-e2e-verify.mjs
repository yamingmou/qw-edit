// 端到端：窗口内每个带时间戳的气泡，其显示时间是否等于按内容匹配到的 DB 消息时间
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
  if (!E) return 'NOT-INJECTED'
  const det = await E.chatDetail(E.currentChatId())
  const sub = (det.subChats ?? det.subs ?? [])[0]
  const all = await E.loadMessages(sub.id)
  const assists = all.filter(x => x.role === 'assistant').sort((a, b) => a.sequence - b.sequence)
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const fmt = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) }
  const rows = []
  document.querySelectorAll('div[class*="container/assistant-message"]').forEach((b) => {
    const span = b.querySelector('span[data-qw-time]')
    if (!span) return
    const shown = span.textContent.trim()
    // 用气泡正文（去时间/按钮字样）找 DB 里的归属：前 16 字精确前缀
    const body = norm(b.innerText).replace(/\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d/g, '').replace(/✎ 编辑重发|↻ 重新生成/g, '').trim()
    // 双通道归因：1) 去 chip 后前缀命中 2) 任一渲染段落全文命中
    let owner = null
    const bare = body.replace(/^(处理已结束|深度思考|已编辑|已完成)\s*/, '').trim()
    const paras = [...b.querySelectorAll('p, li, h1, h2, h3, pre, div[class*="whitespace-pre-wrap"]')].map((el) => norm(el.textContent)).filter((s) => s.length >= 12)
    for (const a of assists) {
      const ak = norm(a.text)
      if (!ak) continue
      let hit = false
      for (const c of [bare.slice(0, 14), body.slice(0, 14)]) {
        if (c.length >= 8 && (ak.startsWith(c) || ak.includes(c) || c.includes(ak.slice(0, c.length)))) { hit = true; break }
      }
      if (!hit) hit = paras.some((p2) => ak.includes(p2.slice(0, 30)) || norm(ak.slice(0, 30)).includes(p2.slice(0, 20)))
      if (hit) { owner = a; break }
    }
    rows.push({ shown, ownerTime: owner && owner.createdAt ? fmt(owner.createdAt) : 'NO-OWNER', match: !!owner && owner.createdAt && fmt(owner.createdAt) === shown, head: body.slice(0, 18) })
  })
  const ok = rows.filter(r => r.match).length
  const bad = rows.filter(r => r.owner && !r.match).length
  return JSON.stringify({ chat: E.currentChatId().slice(0, 8), tagged: rows.length, correct: ok, WRONG: bad, detail: rows.slice(0, 10) }, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
const v = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)
console.log(typeof v === 'string' ? v : JSON.stringify(v))
ws.close()
process.exit(0)
