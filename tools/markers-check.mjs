// 用真实选择器统计挂载 + 生产映射函数里锚点字段计数
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
  const markers = {
    editBtns: document.querySelectorAll('.qw-edit-btn').length,
    regenBtns: document.querySelectorAll('.qw-regen-btn').length,
    inlineDone: document.querySelectorAll('[data-qw-regen="1"]').length,
    times: document.querySelectorAll('[data-qw-time]').length,
    sideDel: document.querySelectorAll('.qw-del-btn').length,
    trash: document.querySelectorAll('.qw-trash-entry').length
  }
  // 生产映射：loadMessages 输出的锚点字段覆盖度（决定编辑/重新生成可用性）
  const cid = window.__qwEdit.currentChatId()
  const d = await window.__qwEdit.chatDetail(cid)
  const sub = (d?.subChats || d?.subs || [])[0]
  const msgs = await window.__qwEdit.loadMessages(sub.id)
  const assts = msgs.filter(x => x.role === 'assistant')
  const users = msgs.filter(x => x.role === 'user')
  const anchorable = assts.filter(x => x.sdkMessageUuid)
  // 模拟生产锚点选取：对第 5 条用户消息找锚点（干跑，不执行回退）
  const probeUser = users[4]
  const anchor = probeUser ? window.__qwEdit.trueRollback ? 'fn-present' : 'fn-missing' : 'no-user'
  return JSON.stringify({
    markers,
    prod: { total: msgs.length, users: users.length, assts: assts.length,
      asstWithSdkUuid: anchorable.length,
      completedWithSdkUuid: anchorable.filter(x => x.status === 'completed').length,
      trueRollback: anchor },
    // 官方操作行结构还在吗（inline 注入依赖）
    officialRow: document.querySelectorAll('[class*="items-center"][class*="gap-"] button').length
  }, null, 1)
})()`)
console.log(out)
ws.close()
process.exit(0)
