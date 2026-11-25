// 回归 v3：审查修复后全链路——API 建会话 → 首轮 ✎ 重置 → uiEdit 弹窗改文 → 真失忆 → Cmd+Enter 重入防护抽查 → 清理
const sleep = ms => new Promise(r => setTimeout(r, ms))
const R = Math.random().toString(36).slice(2, 6)
const Q1 = '回3验' + R + '。记住我的暗号是小明，只回复"收到"'
const Q2 = '回3验' + R + '。记住我的暗号是小红，只回复"收到"'
const HOME = 'mvfhzb4t961plcac'
const say = (...a) => console.log(a.join(' '))
const list0 = await (await fetch('http://127.0.0.1:9222/json')).json()
let ws, i = 0, p2
const open = async () => {
  const page = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(t => t.type === 'page' && t.url.includes('index.html'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  i = 0; p2 = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  await new Promise(r => { ws.onopen = r; setTimeout(r, 2000) })
}
await open()
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); try { ws.send(JSON.stringify({ id, method, params })) } catch { res({}) } })
const ev = async (expression, ap = true) => {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
      const inner = r.result && r.result.result
      if (inner && 'value' in inner) return inner.value
      const ex = r.result && r.result.exceptionDetails
      if (ex) return 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 160)
    } catch {}
    await sleep(2500); try { ws.close() } catch {}; await open(); await call('Runtime.enable')
  }
  return null
}
await call('Runtime.enable')
const bridgeUp = async () => { for (let k = 0; k < 20; k++) { if (await ev(`window.__qwEdit?'UP':'D'`, false) === 'UP') return true; await sleep(1500) } return false }
// 1. API 建会话 + sub
const created = await ev(`(async () => {
  const E = window.__qwEdit
  try {
    const home = await E.chatDetail(${JSON.stringify(HOME)})
    const pid = home.chat && (home.chat.projectId || home.chat.localProjectId)
    const c = await E.trpc('mutation', 'chats.create', { projectId: pid })
    const cc = (c && c.json) ? c.json : c
    const cid = cc && (cc.id || (cc.chat && cc.chat.id))
    if (!cid) return 'NOID:' + JSON.stringify(cc).slice(0, 100)
    // 不再 createSubChat——chats.create 自带唯一 sub（视图渲染的就是它）；再建会双 sub 错位
    const d = await E.chatDetail(cid)
    return JSON.stringify({ cid, sid: d.subs[0] ? d.subs[0].id : null })
  } catch (e) { return 'ERR:' + String(e.message || e).slice(0, 140) }
})()`)
say('create:', created)
if (!created || !created.startsWith('{')) { process.exit(1) }
const { cid, sid } = JSON.parse(created)
const subId = sid || (await ev(`(async () => { const d = await window.__qwEdit.chatDetail(${JSON.stringify(cid)}); return d.subs[0] ? d.subs[0].id : null })()`))
// 2. 首轮 apiSubmit
say('submit1:', await ev(`(async () => {
  const E = window.__qwEdit
  try { await E.apiSubmit({ subChatId: ${JSON.stringify(subId)}, chatId: ${JSON.stringify(cid)}, prompt: ${JSON.stringify(Q1)}, cwd: '', mode: 'agent' }); return 'OK' } catch (e) { return 'ERR:' + String(e.message || e).slice(0, 120) }
})()`))
const waitDone = async (pred, maxK = 40) => {
  for (let k = 0; k < maxK; k++) {
    await sleep(3000)
    const r = await ev(`(async () => {
      const E = window.__qwEdit
      const d = await E.chatDetail(${JSON.stringify(cid)})
      const s = d.subs[0]
      if (!s) return '{"n":0,"busy":false,"lastA":""}'
      const all = await E.loadMessages(s.id, { maxPages: 5 })
      const st = await E.subChatState(s.id)
      return JSON.stringify({ sub: s.id, n: all.length, busy: !!(st && st.streamId), lastA: (all.filter(x => x.role === 'assistant').pop() || {}).text || '', lastFailed: (all.filter(x => x.role === 'assistant').pop() || {}).status === 'failed' })
    })()`)
    if (typeof r !== 'string' || !r.startsWith('{')) continue
    const j = JSON.parse(r)
    if (j.lastFailed) return j // 模型侧失败快速返回，调用方决定重发（网关抖动实测存在）
    if (!j.busy && pred(j)) return j
  }
  return null
}
const j1 = await waitDone(j => j.n >= 2)
say('round1:', j1 ? 'n=' + j1.n : 'TIMEOUT')
if (!j1) { process.exit(1) }
// 3. 导航进新会话
await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(cid)} })`, false)
await sleep(8000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
for (let k = 0; k < 12; k++) {
  const nb = await ev(`document.querySelectorAll('div[class*="container/user-message"]').length`, false)
  if (nb > 0) break
  await sleep(2500)
}
// 4. 点首条 ✎ → 重置 → uiEdit → 改文 → Cmd+Enter 连按（M2 重入防护）→ 只应发一条
say('click-edit:', await ev(`(() => {
  const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const t = bub.find(e => (((e.querySelector('div[class*="whitespace-pre-wrap"]') || e).textContent) || '').trim().indexOf('回3验${R}') === 0)
  const b = t && t.querySelector('.qw-edit-btn')
  if (b) { b.click(); return 'CLICKED' } return 'NOT-FOUND bub=' + bub.length
})()`, false))
await sleep(1200)
say('confirm:', await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /重置会话/.test(x.textContent || '')); if (b) { b.click(); return 'YES' } return 'NO-MODAL' })()`, false))
await sleep(9000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
let modal = 'NO'
for (let k = 0; k < 10; k++) {
  modal = await ev(`(() => { const ta = document.querySelector('.qw-modal-overlay .qw-modal-text'); return ta ? 'MODAL:' + ta.value.slice(0, 12) : 'WAIT' })()`, false)
  if (modal && modal.startsWith('MODAL')) break
  await sleep(2500)
}
say('uiEdit:', modal)
if (!modal || !modal.startsWith('MODAL')) { process.exit(1) }
// 填入新文并连按 5 次 Cmd+Enter（M2：应只提交一次）
say('spam-send:', await ev(`(() => {
  const ta = document.querySelector('.qw-modal-overlay .qw-modal-text')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(Q2)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  for (let k = 0; k < 5; k++) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true }))
  return 'SPAMMED'
})()`, false))
const j2 = await waitDone(j => j.n >= 2, 50)
say('round2:', j2 ? 'n=' + j2.n : 'TIMEOUT')
if (!j2) { process.exit(1) }
const dup = await ev(`(async () => { const d = await window.__qwEdit.chatDetail(${JSON.stringify(cid)}); const all = await window.__qwEdit.loadMessages(d.subs[0].id, { maxPages: 5 }); return all.filter(x => x.role === 'user' && (x.text || '').indexOf('小红') >= 0).length })()`)
say('M2 重入检查（小红提问应=1）:', dup)
// 5. 暗号追问
const j3 = await (async () => {
  for (let a = 0; a < 3; a++) {
    await ev(`(async () => {
      const E = window.__qwEdit
      const d = await E.chatDetail(${JSON.stringify(cid)})
      await E.apiSubmit({ subChatId: d.subs[0].id, chatId: ${JSON.stringify(cid)}, prompt: '我的暗号是什么？只回答名字', cwd: '', mode: 'agent' })
    })()`)
    const j = await waitDone(x => /红|明|不知道/.test(x.lastA), 20)
    if (j && !j.lastFailed) return j
    say('暗号追问重试（模型失败或超时）', a)
  }
  return null
})()
say('暗号:', j3 ? JSON.stringify(j3.lastA.slice(0, 20)) : 'TIMEOUT')
const amnesia = !!j3 && /红/.test(j3.lastA) && !/小明/.test(j3.lastA)
// 6. 取消弹窗找回原文抽查（M3）：round2 发送后弹窗内触发了整页重载 → 先重连+回航，再点首条 ✎
await sleep(9000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(cid)} })`, false)
await sleep(8000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
for (let k = 0; k < 12; k++) {
  const nb = await ev(`document.querySelectorAll('div[class*="container/user-message"]').length`, false)
  if (nb > 0) break
  await sleep(2500)
}
say('click-edit2:', await ev(`(() => {
  const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const t = bub.find(e => (((e.querySelector('div[class*="whitespace-pre-wrap"]') || e).textContent) || '').trim().indexOf('回3验${R}') === 0)
  const b = t && t.querySelector('.qw-edit-btn')
  if (b) { b.click(); return 'CLICKED' } return 'NOT-FOUND'
})()`, false))
await sleep(1200)
await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /重置会话/.test(x.textContent || '')); if (b) b.click(); })()`, false)
await sleep(9000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
let m2 = 'NO'
for (let k = 0; k < 10; k++) {
  m2 = await ev(`(() => { const ta = document.querySelector('.qw-modal-overlay .qw-modal-text'); return ta ? 'MODAL' : 'WAIT' })()`, false)
  if (m2 === 'MODAL') break
  await sleep(2500)
}
await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /取消/.test(x.textContent || '')); if (b) b.click(); return b ? 'CANCELLED' : 'NO-CANCEL' })()`, false)
await sleep(2500)
const kept = await ev(`(() => { const ov = document.querySelector('.qw-modal-overlay'); return ov && /复制原文/.test(ov.textContent || '') ? 'PROMPT-KEPT' : 'NO-PROMPT' })()`, false)
say('M3 取消留存检查:', kept)
// 7. 清理 + 回家
say('purge:', await ev(`(async () => { try { const n = await window.__qwEdit.permanentDeleteChats([{ id: ${JSON.stringify(cid)}, name: '回3验' }], { skipConfirm: true }); return 'PURGED=' + n } catch (e) { return 'FAIL:' + e.message.slice(0, 60) } })()`))
await sleep(2000)
await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(HOME)} })`, false)
say('RESULT', amnesia && String(dup) === '1' && kept === 'PROMPT-KEPT' ? 'ALL-PASS' : 'CHECK amnesia=' + amnesia + ' dup=' + dup + ' kept=' + kept)
try { ws.close() } catch {}
process.exit(0)
