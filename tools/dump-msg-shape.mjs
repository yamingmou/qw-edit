// dump 一条用户 + 一条助手消息的原始结构（不经 loadMessages，直接 tRPC 原始返回）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let i = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}) => new Promise(res => { const id = ++i; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 200)
  return r.result?.result?.value
}

const out = await ev(`(async () => {
  const cid = window.__qwEdit.currentChatId()
  const d = await window.__qwEdit.chatDetail(cid)
  const sub = (d?.subChats || d?.subs || [])[0]
  // 原始 tRPC 返回（不经生产映射）
  const raw = await window.__qwEdit.trpc('query', 'chats.listBySubChat', { subChatId: sub.id, limit: 200 })
  const j = raw?.json ?? raw
  const msgs = j?.messages ?? j
  const u = msgs.find(x => (x.role || x.type) === 'user')
  const a = msgs.find(x => (x.role || x.type) === 'assistant')
  const shape = (x) => x ? { keys: Object.keys(x), metaType: typeof x.metadata, metaKeys: x.metadata && typeof x.metadata === 'object' ? Object.keys(x.metadata) : String(x.metadata)?.slice(0, 60), id: x.id, hasSdk: !!x.sdkMessageUuid } : null
  // 按钮标记实际统计
  const cnt = {
    edit: document.querySelectorAll('.qw-edit-btn').length,
    timeAttr: document.querySelectorAll('[data-qw-time]').length,
    regenAttr: document.querySelectorAll('[data-qw-regen]').length,
    inlineCls: document.querySelectorAll('.qw-regen-inline').length,
    delAttr: document.querySelectorAll('[data-qw-del]').length
  }
  return JSON.stringify({ total: msgs.length, user: shape(u), asst: shape(a), markers: cnt }, null, 1)
})()`)
console.log(out)
ws.close()
process.exit(0)
