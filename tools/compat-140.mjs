// 1.4.0 兼容性体检：注入存活 / 按钮挂载 / tRPC 过程健在 / 消息结构（Node 原生 WebSocket）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
if (!page) { console.log('NO PAGE'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.onopen = r)
let id = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const call = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('cdp-timeout ' + method)) } }, 40000)
})
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return { ERROR: r.result.exceptionDetails.exception?.description?.slice(0, 300) }
  return r.result?.result?.value
}

const out = {}

// 1. 注入存活
out.inject = await ev(`(window.__qwEdit && "ALIVE") || 'NOT-INJECTED'`)

// 2. 按钮挂载统计
out.mounts = await ev(`(() => {
  try {
    return {
      editBtns: document.querySelectorAll('.qw-edit-btn').length,
      regenTop: document.querySelectorAll('.qw-regen-btn').length,
      inlineRegen: document.querySelectorAll('.qw-regen-inline').length,
      times: document.querySelectorAll('.qw-time').length,
      sideDel: document.querySelectorAll('.qw-del-btn').length,
      trashEntry: document.querySelectorAll('.qw-trash-entry').length,
      userBubbles: document.querySelectorAll('[class*="container/user-message"]').length,
      asstBubbles: document.querySelectorAll('[class*="container/assistant-message"]').length
    }
  } catch (e) { return { ERR: String(e) } }
})()`)

// 3. tRPC 通道 + 核心过程健在性（真实只读调用 + 假 ID 探测写过程）
out.trpc = await ev(`(async () => {
  const r = {}
  const T = window.__qwEdit.trpc
  try {
    const s = await T('query', 'chats.listSidebar', {})
    const arr = s?.json ?? s
    r.sidebar = Array.isArray(arr) ? 'OK(' + arr.length + ')' : JSON.stringify(s).slice(0, 80)
  } catch (e) { r.sidebar = 'FAIL: ' + String(e).slice(0, 100) }
  const probes = [
    ['mutation', 'chats.rollbackToMessage'],
    ['mutation', 'chats.updateSubChatSession'],
    ['query',    'chats.listBySubChat'],
    ['mutation', 'agent.submitMessage'],
    ['mutation', 'chats.permanentDeleteChats'],
    ['query',    'chats.listDeleted'],
    ['mutation', 'chats.restoreDeleted'],
    ['mutation', 'chats.emptyTrash'],
    ['query',    'chats.get'],
    ['mutation', 'chats.delete']
  ]
  for (const [type, p] of probes) {
    try { await T(type, p, { chatId: 'nonexistent-xyz', subChatId: 'nonexistent-xyz', id: 'nonexistent-xyz', sdkMessageUuid: 'nonexistent-xyz', input: {} }); r[p] = 'OK(noop)'.slice(0, 12) }
    catch (e) { const msg = String(e); r[p] = /no [^.]*-?procedure|No \w+-procedure|not found/i.test(msg) ? '!! MISSING' : 'exists(' + msg.slice(0, 50) + ')' }
    await new Promise(res => setTimeout(res, 400)) // 防通道积压
  }
  return r
})()`)

// 4. 旧消息处理：当前会话投影的字段结构（REBUILD 定位依赖）
out.msgShape = await ev(`(async () => {
  try {
    const cid = window.__qwEdit.currentChatId()
    if (!cid) return 'NO-CURRENT-CHAT (视图不在会话上)'
    const d = await window.__qwEdit.chatDetail(cid)
    const subs = d?.subChats || d?.subs || []
    if (!subs.length) return 'NO-SUBS'
    const msgs = await window.__qwEdit.loadMessages(subs[0].id)
    const users = msgs.filter(x => x.role === 'user')
    const assts = msgs.filter(x => x.role === 'assistant')
    return { sub: subs[0].id, total: msgs.length, users: users.length, assts: assts.length,
      userWithSdkUuid: users.filter(x => x.metadata?.sdkMessageUuid).length,
      asstWithSdkUuids: assts.filter(x => x.metadata?.sdkMessageUuid || x.metadata?.sdkMessageUuids).length,
      sampleUserMetaKeys: users[0] ? Object.keys(users[0].metadata || {}).slice(0, 8) : null }
  } catch (e) { return 'FAIL: ' + String(e).slice(0, 200) }
})()`)

console.log(JSON.stringify(out, null, 1))
ws.close(); process.exit(0)
