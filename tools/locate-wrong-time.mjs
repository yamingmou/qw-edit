// 定位用户报告的 2026-09-18 19:51:17 时间元素：挂在哪个气泡、气泡真实内容、DB 里谁的 createdAt 对得上
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
  const hits = []
  // 1. 页面上所有含 2026-09-18 19:5 文本的节点
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent
    if (/2026-09-18 19:5/.test(t)) {
      let el = walker.currentNode.parentElement
      const bubble = el ? el.closest('div[class*="container/user-message"], div[class*="container/assistant-message"]') : null
      hits.push({
        text: t.trim().slice(0, 30),
        ourSpan: !!(el && el.closest('[data-qw-time]')) ,
        bubbleHead: bubble ? (bubble.innerText || '').replace(/\\s+/g, ' ').slice(0, 40) : 'NO-BUBBLE'
      })
    }
  }
  // 2. DB 里 createdAt 落在 09-18 19:51 前后的消息 与 该气泡文本对应的消息
  const det = await E.chatDetail(E.currentChatId())
  const sub = (det.subChats ?? det.subs ?? [])[0]
  const all = await E.loadMessages(sub.id, { maxPages: 2 })
  const near = all.filter(x => x.createdAt && new Date(x.createdAt).getMonth() === 8 && new Date(x.createdAt).getHours() === 19 && new Date(x.createdAt).getMinutes() >= 45)
    .map(x => ({ role: x.role, seq: x.sequence, t: new Date(x.createdAt).toLocaleString('zh-CN').slice(5, 16), text: (x.text || '').replace(/\\s+/g, ' ').slice(0, 30) }))
  // 3. 气泡内容(第1步找到的)在 DB 里的真实时间
  const ownerInfo = []
  for (const h of hits.slice(0, 3)) {
    const head = h.bubbleHead.slice(0, 20)
    const m = head && all.find(x => (x.text || '').replace(/\\s+/g, ' ').startsWith(head.slice(0, 12)))
    if (m) ownerInfo.push({ bubble: head, dbTime: m.createdAt ? new Date(m.createdAt).toLocaleString('zh-CN') : null, seq: m.sequence, role: m.role })
  }
  return JSON.stringify({ hits, dbNear: near.slice(0, 6), ownerInfo }, null, 1)
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
const v = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description?.slice(0, 300)
console.log(typeof v === 'string' ? v : JSON.stringify(v))
ws.close()
process.exit(0)
