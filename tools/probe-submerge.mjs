// 取证：这个会话到底由哪些 subChat 组成、「重启了。」住在哪个 sub、界面是否合并渲染多个 sub 的历史
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
  const out = { chatId, search: location.search.slice(0, 120), subs: [] }

  // 1. 原始 chats.get：顶层键 + subChats 全量（含 sessionId / 时间）
  const raw = await E.trpc('query', 'chats.get', { id: chatId })
  const det = raw && raw.json ? raw.json : raw
  const chatObj = det && det.chat ? det.chat : det
  out.chatKeys = chatObj ? Object.keys(chatObj).join(',') : 'NULL'
  const subsArr = (det && (det.subChats || (det.chat && det.chat.subChats))) || []
  out.rawSubCount = subsArr.length

  // 2. 每个 sub 的消息：数量、是否有「重启了。」、首尾样本
  const needle = '重启了'
  const domBubbles = [...document.querySelectorAll('div[class*="container/user-message"]')]
  for (let k = 0; k < subsArr.length; k++) {
    const s = subsArr[k]
    const rec = { k, id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, sessionId: s.sessionId }
    try {
      const all = await E.loadMessages(s.id, { maxPages: 60 })
      rec.msgs = all.length
      rec.users = all.filter(x => x.role === 'user').length
      rec.capped = !!all.qwCapped
      const hit = all.filter(x => x.role === 'user' && (x.text || '').indexOf(needle) === 0)
      rec.restartHits = hit.map(x => ({ seq: x.sequence, time: x.createdAt }))
      rec.first = clip(all[0] && all[0].text, 24)
      rec.last = clip(all[all.length - 1] && all[all.length - 1].text, 24)
    } catch (e) { rec.err = clip(e.message, 80) }
    out.subs.push(rec)
  }

  // 3. chatDetail 排序后的 subs[0] 是哪个（我们当前代码取的就是它）
  const d2 = await E.chatDetail(chatId)
  out.pickedSub = d2.subs[0] ? d2.subs[0].id : null

  // 4. DOM 现状：用户气泡数、「重启了。」气泡数
  out.domUserBubbles = domBubbles.length
  const pure = el => { const p = el.querySelector('div[class*="whitespace-pre-wrap"]'); return ((p || el).textContent || '') }
  out.domRestartBubbles = domBubbles.filter(el => pure(el).trim().indexOf(needle) === 0).length

  // 5. 复现失败路径：用 subs[0] 的投影跑 selectUserMsg 找「重启了。」气泡
  try {
    const all0 = await E.loadMessages(d2.subs[0].id, { maxPages: 60 })
    const target = domBubbles.find(el => pure(el).trim().indexOf(needle) === 0)
    out.subs0Msgs = all0.length
    if (target) {
      try { const m0 = E.selectUserMsg(all0, target); out.selectOnSub0 = { ok: true, seq: m0.sequence, sub: d2.subs[0].id } }
      catch (e) { out.selectOnSub0 = { ok: false, err: clip(e.message, 90) } }
    } else out.selectOnSub0 = 'NO-DOM-TARGET(该气泡没在渲染窗口内，需滚动)'
  } catch (e) { out.selectOnSub0 = { fatal: clip(e.message, 90) } }

  return JSON.stringify(out, null, 1)
})()`
await call('Runtime.enable')
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 })
console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r, null, 1))
ws.close()
process.exit(0)
