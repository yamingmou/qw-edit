// 下钻：对当前渲染的 6 个用户气泡做文本提取取证——pure div 是什么、提取出什么、和投影哪条对得上、匹配在哪一步死
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m, p = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
const expr = `(async () => {
  const E = window.__qwEdit
  const clip = (s, n) => (s || '').replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, n || 40)
  const chatId = E.currentChatId()
  const d = await E.chatDetail(chatId)
  const all = await E.loadMessages(d.subs[0].id, { maxPages: 60 })
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
  const bubbles = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const rows = []
  for (const el of bubbles) {
    const pureEl = el.querySelector('div[class*="whitespace-pre-wrap"]')
    const info = {
      hasPureDiv: !!pureEl,
      pureClass: pureEl ? (pureEl.className || '').slice(0, 60) : null,
      pureCount: el.querySelectorAll('div[class*="whitespace-pre-wrap"]').length,
      pureText: clip(pureEl ? pureEl.textContent : el.textContent, 60),
      bubbleHead: clip(el.textContent, 60),
      hasTimeChip: !!el.querySelector('[data-qw-time]'),
      hasOurBtn: !!el.querySelector('.qw-edit-btn'),
    }
    // 这条提取文本能不能在投影里按 exact / prefix 命中
    const expect = (pureEl ? pureEl.textContent : el.textContent) || ''
    const en = norm(expect)
    info.exactHit = all.filter(x => x.role === 'user' && norm(x.text) === en).length
    info.prefixHit = all.filter(x => x.role === 'user' && norm(x.text).startsWith(en.slice(0, 30))).length
    info.prefix30 = en.slice(0, 30)
    // 若命中，selectUserMsg 是否成功
    try { const m = E.selectUserMsg(all, el); info.select = { ok: true, seq: m.sequence } } catch (e) { info.select = { err: clip(e.message, 70) } }
    rows.push(info)
  }
  // 顺带：投影里「重启了。」两条的文本原文（看有没有隐藏字符）
  const restarts = all.filter(x => x.role === 'user' && (x.text || '').replace(/\\s+/g, ' ').trim().startsWith('重启了')).map(x => ({ seq: x.sequence, raw: JSON.stringify(x.text) }))
  return JSON.stringify({ rows, restarts, sourceChatId: (d.chat && d.chat.sourceChatId) || null }, null, 1)
})()`
await call('Runtime.enable')
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 })
console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r, null, 1))
ws.close()
process.exit(0)
