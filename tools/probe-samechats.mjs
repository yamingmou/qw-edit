// 同名会话大起底：列出侧边栏所有会话（含已删除），标出名字相同/相似的，查各自 chatKeys 里的 identityKey/projectId/activeLegokitId，
// 定位探针抓错会话的原因（currentChatId 的激活行判定撞了多个同名会话？）
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
  const clip = (s, n) => String(s == null ? '' : s).replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, n || 40)
  const out = { urlChat: (new URLSearchParams(location.search)).get('chat'), currentChatId: E.currentChatId(), sameName: [], allSidebar: [] }

  // 侧边栏全量 + 已删除全量
  let sb = await E.trpc('query', 'chats.listSidebar')
  sb = (sb && sb.json) ? sb.json : sb
  const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
  let del = []
  try { del = await E.trpc('query', 'chats.listDeleted'); del = (del && del.json) ? del.json : del; del = Array.isArray(del) ? del : (del && del.chats) || [] } catch (e) { out.delErr = clip(e.message, 60) }

  const inspect = async (c, where) => {
    const rec = { where, id: c.id, name: clip(c.name, 30) }
    try {
      const raw = await E.trpc('query', 'chats.get', { id: c.id })
      const det = raw && raw.json ? raw.json : raw
      const co = det && det.chat ? det.chat : det
      rec.identityKey = clip(co.identityKey, 40)
      rec.projectId = clip(co.projectId, 20)
      rec.sessionNamespace = clip(co.sessionNamespace, 30)
      rec.activeLegokitId = clip(co.activeLegokitId, 30)
      const subs = (det && (det.subChats || (det.chat && det.chat.subChats))) || []
      rec.subs = subs.length
      rec.msgs = subs.length ? (await E.loadMessages(subs[0].id, { maxPages: 60 })).length : 0
      if (subs.length) {
        const d0 = await E.loadMessages(subs[0].id, { maxPages: 60 })
        rec.restartSeqs = d0.filter(x => x.role === 'user' && clip(x.text, 4) === '重启了').map(x => x.sequence)
        rec.lastUser = clip(d0.filter(x => x.role === 'user').pop()?.text, 30)
      }
    } catch (e) { rec.err = clip(e.message, 70) }
    return rec
  }

  // 名字像"插件开发者"或包含"开发"的
  const pool = [...chats.map(c => ({ c, w: 'sidebar' })), ...del.map(c => ({ c, w: 'deleted' }))]
  for (const { c, w } of pool) {
    const n = clip(c.name, 40)
    if (n.indexOf('插件') >= 0 || n.indexOf('开发') >= 0 || n.indexOf('输入口') >= 0) out.sameName.push(await inspect(c, w))
  }
  // 顺带存侧边栏全名清单（截短）
  out.allSidebar = chats.map(c => clip(c.name, 24)).slice(0, 30)
  return JSON.stringify(out, null, 1)
})()`
await call('Runtime.enable')
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 })
const fs = await import('node:fs')
fs.writeFileSync('tools/out-samechats.json', (r.result && r.result.value) ? r.result.value : JSON.stringify(r, null, 1))
console.log('written', fs.statSync('tools/out-samechats.json').size)
ws.close()
process.exit(0)
