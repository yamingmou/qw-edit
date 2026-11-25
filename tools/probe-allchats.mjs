// 全景：所有窗口目标 × 所有名为插件开发者/带(1)的会话（sidebar+归档+回收站）× 每个会话的全部 subChat 消息分布
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pages = targets.filter(t => t.type === 'page')
const out = { windows: [], chats: [] }
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = r; setTimeout(r, 3000) })
  let i = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const call = (m2, pr = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m2, params: pr })) })
  try { await call('Runtime.enable') } catch {}
  const expr = `(async () => {
    const E = window.__qwEdit
    const clip = (s, n) => String(s == null ? '' : s).replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, n || 30)
    const out = { win: { url: location.search.slice(0, 90), chat: E.currentChatId(), dom: [] }, chats: [] }
    const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
    for (const el of bub) {
      const p = el.querySelector('div[class*="whitespace-pre-wrap"]')
      out.win.dom.push(clip(p ? p.textContent : el.textContent, 34))
    }
    // 名字匹配的所有会话（含归档与回收站）
    let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
    let chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
    let arch = []
    try { let a = await E.trpc('query', 'chats.listArchived'); a = (a && a.json) ? a.json : a; arch = Array.isArray(a) ? a : (a && a.chats) || [] } catch (e) { out.archErr = clip(e.message, 50) }
    let del = []
    try { let d = await E.trpc('query', 'chats.listDeleted'); d = (d && d.json) ? d.json : d; del = Array.isArray(d) ? d : (d && d.chats) || [] } catch (e) { out.delErr = clip(e.message, 50) }
    const pool = [...chats.map(c => ({ c, w: 'sidebar' })), ...arch.map(c => ({ c, w: 'archived' })), ...del.map(c => ({ c, w: 'deleted' }))]
    for (const { c, w } of pool) {
      if (clip(c.name, 30).indexOf('插件开发者') < 0) continue
      const rec = { where: w, id: c.id, name: clip(c.name, 30), subs: [] }
      try {
        const raw = await E.trpc('query', 'chats.get', { id: c.id })
        const det = raw && raw.json ? raw.json : raw
        const subs = (det && (det.subChats || (det.chat && det.chat.subChats))) || []
        rec.rawSubCount = subs.length
        for (const s of subs) {
          const one = { id: s.id, createdAt: String(s.createdAt || '').slice(0, 10), updatedAt: String(s.updatedAt || '').slice(0, 16) }
          const msgs = await E.loadMessages(s.id, { maxPages: 60 })
          one.n = msgs.length
          one.first = clip(msgs[0] && msgs[0].text, 20)
          one.last = clip(msgs[msgs.length - 1] && msgs[msgs.length - 1].text, 20)
          one.restart = msgs.some(x => x.role === 'user' && clip(x.text, 4) === '重启了')
          one.tuiGithub = msgs.some(x => clip(x.text, 8).indexOf('推github') >= 0 || clip(x.text, 8) === '已经新版本了')
          rec.subs.push(one)
        }
      } catch (e) { rec.err = clip(e.message, 60) }
      out.chats.push(rec)
    }
    out.poolNames = pool.map(({ c, w }) => w + ':' + clip(c.name, 24))
    return JSON.stringify(out)
  })()`
  let val
  try {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 })
    val = r.result && r.result.value ? r.result.value : JSON.stringify(r)
  } catch (e) { val = 'ERR ' + String(e) }
  out.windows.push(val)
  try { ws.close() } catch {}
}
const fs = await import('node:fs')
fs.writeFileSync('tools/out-allchats.json', JSON.stringify(out, null, 1))
console.log('written', fs.statSync('tools/out-allchats.json').size, 'windows:', out.windows.length)
process.exit(0)
