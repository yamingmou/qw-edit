// 只读取证：找「测试。输入出1」所在会话 + 若干新老会话，dump 助手消息的 status/锚点字段实况
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r; setTimeout(r, 2500) })
let i = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (m2, pr = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method: m2, params: pr })) })
const expr = `(async () => {
  const E = window.__qwEdit
  const clip = (s, n) => String(s == null ? '' : s).replace(/[\\r\\n\\t]+/g, ' ').slice(0, n || 28)
  let sb = await E.trpc('query', 'chats.listSidebar'); sb = (sb && sb.json) ? sb.json : sb
  const chats = Array.isArray(sb) ? sb : (sb && sb.chats) || []
  const out = { version: (navigator.userAgent.match(/QwenWork\\\/([\\d.]+)/) || [])[1] || 'n/a', found: [], sample: [] }

  // 原始消息 dump 器：不经 loadMessages 的字段映射，直接看存储形态
  const rawDump = async (subId, n) => {
    let d = await E.trpc('query', 'chats.listBySubChat', { subChatId: subId, limit: Math.min(n || 200, 200) })
    d = (d && d.json) ? d.json : d
    const msgs = Array.isArray(d) ? d : (d && d.messages) || []
    return msgs
  }

  for (const c of chats.slice(0, 12)) {
    try {
      const det = await E.trpc('query', 'chats.get', { id: c.id })
      const dd = (det && det.json) ? det.json : det
      const subs = (dd && (dd.subChats || (dd.chat && dd.chat.subChats))) || []
      if (!subs.length) continue
      const msgs = await rawDump(subs[0].id, 200)
      if (!msgs.length) continue
      const first = msgs[0]
      const isTarget = clip(first.text || first.content, 30).indexOf('测试') >= 0 && clip(first.text || first.content, 30).indexOf('输入') >= 0
      const asst = msgs.filter(x => (x.role === 'assistant'))
      const withUuid = asst.filter(x => x.metadata && x.metadata.sdkMessageUuid)
      const statuses = [...new Set(asst.map(x => String(x.metadata && (x.metadata.status ?? x.metadata.taskStatus))))]
      const metaKeys = asst.length ? [...new Set(Object.keys(asst[asst.length - 1].metadata || {}))] : []
      const rec = {
        name: clip(c.name, 18), id: c.id, n: msgs.length, created: String(c.createdAt || '').slice(0, 10),
        asst: asst.length, asstWithUuid: withUuid.length, statuses: statuses.join('|').slice(0, 40), metaKeys: metaKeys.join(',').slice(0, 120),
      }
      if (isTarget) {
        rec.firstText = clip(first.text || first.content, 30)
        // 逐条列出（前 12 条）角色/status/有无锚点
        rec.rows = msgs.slice(0, 12).map(x => x.role[0] + ':' + String(x.metadata && (x.metadata.status ?? x.metadata.taskStatus)) + ':' + (x.metadata && x.metadata.sdkMessageUuid ? 'U' : '-'))
        // 顶层字段有没有 uuid 变体
        const lastA = asst[asst.length - 1]
        if (lastA) rec.assistantFull = Object.fromEntries(Object.entries(lastA).filter(([k, v]) => typeof v !== 'object' || k === 'metadata').map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 40)]))
        out.found.push(rec)
      } else out.sample.push(rec)
    } catch (e) { out.sample.push({ name: clip(c.name, 12), err: clip(e.message, 60) }) }
  }
  return JSON.stringify({ found: out.found, sample: out.sample, version: out.version }, null, 1)
})()`
await call('Runtime.enable')
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 })
const fs = await import('node:fs')
fs.writeFileSync('tools/out-era.json', r.result && r.result.value ? r.result.value : JSON.stringify(r).slice(0, 4000))
console.log('written', fs.statSync('tools/out-era.json').size)
ws.close()
process.exit(0)
