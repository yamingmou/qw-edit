#!/usr/bin/env node
// 1.4.0 真实按钮端到端回归：新建一次性会话 → ↻重新生成(截断+重发+不跳会话) → ✎编辑(截断+草稿回填+改文重发) → 旧消息挂载验证 → 清理
// 外部驱动，点击后整页重载属预期（容忍断连重连）；点击前视图守卫（不在测试会话绝不点击）
const PORT = 9222
const HARD = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2) }, 560000)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const call = (method, params = {}, timeout = 60000) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { rej(new Error('cdp-timeout')) }, timeout)
    pend.set(i, (r) => { clearTimeout(t); res(r) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr, timeout = 60000) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
    if (r.result?.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ev, close: () => { try { ws.close() } catch {} } }
}

const report = { phases: [], ok: false }
const say = (k, v) => { report.phases.push({ [k]: v }); console.log('•', k, JSON.stringify(v).slice(0, 160)) }
let c = await connect()

// ---------- Phase 1: 建一次性会话 + 两轮对话（页内自跑，容忍长耗时） ----------
const rand = Math.random().toString(36).slice(2, 6)
say('rand', rand)
const mk = await c.ev(`(async () => {
  const E = window.__qwEdit
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const m = E.trpc.bind(null, 'mutation'), q = E.trpc.bind(null, 'query')
  const origin = E.currentChatId()
  const od = await E.chatDetail(origin)
  const projectId = od?.chat?.projectId || od?.projectId
  if (!projectId) return { err: 'no projectId' }
  const cr = await m('chats.create', { projectId, chatType: 'task' })
  const cj = cr?.json ?? cr
  const chatId = cj?.chatId ?? cj?.id
  const det = await E.chatDetail(chatId)
  const sub = (det?.subChats || det?.subs || [])[0]
  if (!sub) return { err: 'no sub', chatId }
  async function turn(prompt, afterSeq) {
    await m('agent.submitMessage', { subChatId: sub.id, chatId, prompt, cwd: 'process.env.QW_CWD || "/path/to/your/workspace"', historyEnabled: true })
    for (let t = 0; t < 60; t++) {
      await sleep(3000)
      const msgs = await E.loadMessages(sub.id)
      const a = msgs.find(x => x.role === 'assistant' && x.sequence > afterSeq && x.sdkMessageUuid)
      const sd = await E.subChatState(sub.id)
      if (a && !sd?.streamId) return a
    }
    return null
  }
  const a1 = await turn('请记住口令 XQ' + '${rand}，只回复：收到。', -1)
  if (!a1) return { err: 'turn1 timeout', chatId }
  const a2 = await turn('只回复：好。', a1.sequence)
  if (!a2) return { err: 'turn2 timeout', chatId }
  return { chatId, subChatId: sub.id, origin, a1seq: a1.sequence, a2seq: a2.sequence }
})()`, 300000)
if (mk.err) { console.log('PHASE1 FAIL', JSON.stringify(mk)); process.exit(1) }
say('created', { chatId: mk.chatId, origin: mk.origin })
const P1 = `const E=window.__qwEdit, CID='${mk.chatId}', SUB='${mk.subChatId}', ORIGIN='${mk.origin}', RAND='${rand}'`

// 视图导航到测试会话（点侧边栏条目；标题应含口令）
const nav1 = await c.ev(`(async () => {
  ${P1}
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const items = E.sidebarItemsByName ? null : null
  // 通用：找标题含 XQ 的侧边栏行
  const rows = [...document.querySelectorAll('button, [role="button"], li *')].filter(el => (el.textContent||'').includes('XQ' + RAND) && el.getBoundingClientRect().x < 300)
  if (!rows.length) return 'NOROW'
  rows[rows.length-1].click()
  for (let t = 0; t < 20; t++) { await sleep(500); if (E.currentChatId() === CID) return 'ONCHAT' }
  return 'WRONGCHAT:' + E.currentChatId()
})()`)
say('nav', nav1)
if (nav1 !== 'ONCHAT') { try { await c.ev(`(async()=>{ const m=window.__qwEdit.trpc.bind(null,'mutation'); await m('chats.delete',{id:'${mk.chatId}'}); await m('chats.permanentDelete',{id:'${mk.chatId}'}); })()`) } catch {} process.exit(1) }

// 视图守卫 + 按钮就绪断言
const ready = await c.ev(`(async () => {
  ${P1}
  if (E.currentChatId() !== CID) return { guard: 'FAIL' }
  const msgs = await E.loadMessages(SUB)
  return { guard: 'OK', n: msgs.length,
    editBtns: document.querySelectorAll('.qw-edit-btn').length,
    regenBtns: document.querySelectorAll('.qw-regen-btn').length,
    times: document.querySelectorAll('[data-qw-time]').length }
})()`)
say('ready', ready)
if (ready.guard !== 'OK' || ready.n !== 4) { console.log('GUARD FAIL — abort, chat left for manual'); process.exit(1) }

// ---------- Phase 2: 真实点击 A2 回答的 ↻（点完即返回；trueRollback 会整页重载） ----------
const click1 = await c.ev(`(() => {
  ${P1}
  if (window.__qwEdit.currentChatId() !== CID) return 'GUARD-ABORT'
  const bubbles = [...document.querySelectorAll('[class*="container/assistant-message"]')]
  const last = bubbles[bubbles.length - 1]
  const btn = last && (last.querySelector('.qw-regen-inline') || last.querySelector('.qw-regen-btn'))
  if (!btn) return 'NOBTN'
  btn.click()
  setTimeout(() => { const ok = document.querySelector('.qw-modal [data-act="ok"]'); if (ok) ok.click() }, 400)
  return 'CLICKED'
})()`)
say('click-regen', click1)
if (click1 !== 'CLICKED') process.exit(1)

// 等重载完成 + 新一轮流式结束 + 结构断言
await sleep(6000)
try { c.close() } catch {}
c = await connect()
let regenAssert = null
for (let t = 0; t < 40; t++) {
  try {
    regenAssert = await c.ev(`(async () => {
      ${P1}
      const E2 = window.__qwEdit
      if (!E2) return { wait: 'not-injected' }
      if (E2.currentChatId() !== CID) return { jump: 'FAIL -> ' + E2.currentChatId() }
      const msgs = await E2.loadMessages(SUB)
      const sd = await E2.subChatState(SUB)
      const users = msgs.filter(x => x.role === 'user')
      const passers = users.filter(x => (x.text || '').includes('好。'))
      if (msgs.length >= 4 && passers.length === 1 && !sd?.streamId) {
        return { done: true, n: msgs.length, dupPasser: passers.length, lastRole: msgs[msgs.length-1].role }
      }
      return { wait: 'pending', n: msgs.length, stream: !!sd?.streamId }
    })()`)
    if (regenAssert.done || regenAssert.jump) break
  } catch { /* 重载窗口期断连 */ }
  await sleep(5000)
}
say('regen-assert', regenAssert)
if (!regenAssert || !regenAssert.done) { console.log('REGEN FAIL', JSON.stringify(regenAssert)); process.exit(1) }

// ---------- Phase 3: 真实点击 U2(“只回复：好。”)的 ✎ → 截断 + 草稿回填 ----------
const click2 = await c.ev(`(async () => {
  ${P1}
  const E2 = window.__qwEdit
  if (E2.currentChatId() !== CID) return 'GUARD-ABORT'
  const bubbles = [...document.querySelectorAll('[class*="container/user-message"]')]
  let target = null
  for (const b of bubbles) { const t = (b.innerText || ''); if (t.includes('只回复：好。') && !t.includes('XQ')) { target = b; break } }
  if (!target) return 'NOBUBBLE'
  const btn = target.querySelector('.qw-edit-btn')
  if (!btn) return 'NOEDITBTN'
  btn.click()
  setTimeout(() => { const ok = document.querySelector('.qw-modal [data-act="ok"]'); if (ok) ok.click() }, 400)
  return 'CLICKED'
})()`)
say('click-edit', click2)
if (click2 !== 'CLICKED') process.exit(1)

await sleep(8000)
try { c.close() } catch {}
c = await connect()
let editAssert = null
for (let t = 0; t < 24; t++) {
  try {
    editAssert = await c.ev(`(async () => {
      ${P1}
      const E2 = window.__qwEdit
      if (!E2) return { wait: 'not-injected' }
      if (E2.currentChatId() !== CID) return { jump: 'FAIL' }
      const msgs = await E2.loadMessages(SUB)
      const comp = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
      const cv = comp ? (comp.value ?? comp.textContent ?? '') : ''
      if (msgs.length === 2 && cv.includes('只回复：好。')) return { done: true, n: msgs.length, draft: cv.slice(0, 30) }
      return { wait: true, n: msgs.length, draft: cv.slice(0, 20) }
    })()`)
    if (editAssert.done || editAssert.jump) break
  } catch {}
  await sleep(4000)
}
say('edit-assert', editAssert)
if (!editAssert || !editAssert.done) { console.log('EDIT FAIL', JSON.stringify(editAssert)); process.exit(1) }

// ---------- Phase 4: 改文重发（模拟用户编辑后回车）→ 验证不跳会话+结构恢复 ----------
const send2 = await c.ev(`(async () => {
  ${P1}
  const E2 = window.__qwEdit
  if (E2.currentChatId() !== CID) return 'GUARD-ABORT'
  const comp = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  if (!comp) return 'NOCOMPOSER'
  const setter = Object.getOwnPropertyDescriptor(comp.constructor.prototype, comp.tagName === 'TEXTAREA' ? 'value' : 'textContent').set
  setter.call(comp, '只回复：改发了。')
  comp.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'SENT'
})()`)
say('resend', send2)
let finalAssert = null
for (let t = 0; t < 40; t++) {
  await sleep(5000)
  try {
    finalAssert = await c.ev(`(async () => {
      ${P1}
      const E2 = window.__qwEdit
      if (E2.currentChatId() !== CID) return { jump: 'FAIL' }
      const msgs = await E2.loadMessages(SUB)
      const sd = await E2.subChatState(SUB)
      const edited = msgs.filter(x => x.role === 'user' && (x.text || '').includes('改发了'))
      const olds = msgs.filter(x => x.role === 'user' && (x.text || '').includes('只回复：好。'))
      if (msgs.length >= 4 && edited.length === 1 && olds.length === 0 && !sd?.streamId) {
        return { done: true, n: msgs.length, roles: msgs.map(x => x.role[0]).join('') }
      }
      return { wait: true, n: msgs.length, olds: olds.length }
    })()`)
    if (finalAssert.done || finalAssert.jump) break
  } catch {}
}
say('final', finalAssert)

// ---------- Phase 5: 旧消息兼容 —— 回开发会话滚到最老消息看挂载 ----------
try { c.close() } catch {}
c = await connect()
const oldCheck = await c.ev(`(async () => {
  const E2 = window.__qwEdit
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const rows = [...document.querySelectorAll('button, [role="button"], li *')].filter(el => (el.textContent||'').includes('XQ' + '${rand}'))
  if (rows.length) rows[rows.length-1].click() // 先离开测试会话（稍后删它）
  await sleep(1500)
  const sc = document.querySelector('[class*="overflow-y-auto"]')
  if (sc) { sc.scrollTop = 0; }
  window.scrollTo(0, 0)
  await sleep(2500)
  const sc2 = document.querySelector('[class*="overflow-y-auto"]')
  if (sc2) { sc2.scrollTop = 0; }
  await sleep(2500)
  const first = document.querySelectorAll('[class*="container/user-message"]')[0]
  return {
    onDev: E2.currentChatId() === '${mk.origin}',
    editBtnsVisible: document.querySelectorAll('.qw-edit-btn').length,
    times: document.querySelectorAll('[data-qw-time]').length,
    firstHasEdit: !!(first && first.querySelector('.qw-edit-btn')),
    firstHasTime: !!(first && first.querySelector('[data-qw-time]')),
    firstText: (first?.innerText || '').slice(0, 30)
  }
})()`)
say('old-msgs', oldCheck)

// ---------- Phase 6: 清理测试会话（按 id，不点击） ----------
const clean = await c.ev(`(async () => {
  const m = window.__qwEdit.trpc.bind(null, 'mutation')
  await m('chats.delete', { id: '${mk.chatId}' })
  await m('chats.permanentDelete', { id: '${mk.chatId}' })
  return 'cleaned'
})()`)
say('cleanup', clean)

report.ok = !!(finalAssert?.done && oldCheck?.firstHasEdit && oldCheck?.firstHasTime)
console.log('\n==== VERDICT:', report.ok ? '✅ 1.4.0 全链路通过' : '❌ 有失败项，见 phases')
c.close()
clearTimeout(HARD)
process.exit(report.ok ? 0 : 1)
