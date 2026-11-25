// E2E v2（1.4.0 弹窗+API 链路）：目标=一次性测试会话 mvtdg8uqoh2gsq7n（测试输入输出，垃圾内容）
// 链路：apiSubmit 追加轮 → 点首条 ✎ → uiConfirm(重置) → 重载 → uiEdit 弹窗改文 → 发送(API) →
//       暗号追问(应小红非小明) → 点最后回答 ↻ → 锚定 REBUILD 自动重发 → 清理 → 回原会话
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = 'mvtdg8uqoh2gsq7n'
const HOME = 'mvfhzb4t961plcac'
const R = Math.random().toString(36).slice(2, 6)
const log = []
const say = (...a) => { const s = a.join(' '); log.push(s); console.log(s) }
const list0 = await (await fetch('http://127.0.0.1:9222/json')).json()
let page = list0.find(t => t.type === 'page' && t.url.includes('index.html'))
let ws, i = 0, p2
const open = () => new Promise(async (res) => {
  page = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(t => t.type === 'page' && t.url.includes('index.html'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  i = 0; p2 = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  ws.onopen = () => { res() }
  setTimeout(res, 2500)
})
await open()
const call = (method, params = {}) => new Promise(res => { const id = ++i; p2.set(id, res); try { ws.send(JSON.stringify({ id, method, params })) } catch { res({}) } })
const ev = async (expression, ap = true) => {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: ap, returnByValue: true })
      const inner = r.result && r.result.result
      if (inner && 'value' in inner) return inner.value
      const ex = r.result && r.result.exceptionDetails
      if (ex) return 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 140)
    } catch {}
    await sleep(2500); try { ws.close() } catch {}; await open(); await call('Runtime.enable')
  }
  return null
}
await call('Runtime.enable')
const bridgeUp = async () => { for (let k = 0; k < 20; k++) { if (await ev(`window.__qwEdit?'UP':'D'`, false) === 'UP') return true; await sleep(1500) } return false }
const navTo = async (chatId) => {
  await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(chatId)} })`, false)
  await sleep(8000)
  try { ws.close() } catch {}
  await open(); await call('Runtime.enable')
  const up = await bridgeUp()
  const cur = await ev(`new URLSearchParams(location.search).get('chat')`, false)
  return { up, cur }
}
const submit = (chatId, text) => ev(`(async () => {
  const E = window.__qwEdit
  const d = await E.chatDetail(${JSON.stringify(chatId)})
  const sub = d.subs[0]
  const cwd = (d.chat && (d.chat.worktreePath || (d.chat.project && d.chat.project.path) || d.chat.outputDirectory)) || ''
  try { const r = await E.apiSubmit({ subChatId: sub.id, chatId: ${JSON.stringify(chatId)}, prompt: ${JSON.stringify(text)}, cwd, mode: sub.mode }); return 'OK' + (r && r.queued ? '-QUEUED' : '') } catch (e) { return 'ERR:' + String(e.message || e).slice(0, 120) }
})()`)
const waitDone = async (chatId, pred, maxK = 40) => {
  for (let k = 0; k < maxK; k++) {
    await sleep(3000)
    const r = await ev(`(async () => {
      const E = window.__qwEdit
      const d = await E.chatDetail(${JSON.stringify(chatId)})
      const sub = d.subs[0]
      const all = await E.loadMessages(sub.id, { maxPages: 5 })
      const st = await E.subChatState(sub.id)
      return JSON.stringify({ sub: sub.id, n: all.length, busy: !!(st && st.streamId), lastA: (all.filter(x => x.role === 'assistant').pop() || {}).text || '' })
    })()`)
    if (!r || !r.startsWith('{')) continue
    const j = JSON.parse(r)
    if (!j.busy && pred(j)) return j
  }
  return null
}
// —— 1. 导航到目标 ——
say('nav:', JSON.stringify(await navTo(T)))
// —— 2. 追加一轮（小明）——
say('submit1:', await submit(T, '记验' + R + '。记住我的暗号是小明，只回复"收到"'))
const j1 = await waitDone(T, j => j.lastA.indexOf('收') >= 0)
say('round1:', j1 ? 'n=' + j1.n : 'TIMEOUT')
if (!j1) { process.exit(1) }
// —— 3. 点首条 ✎ → uiConfirm 重置 ——
say('scroll-top:', await ev(`(() => {
  const scs = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300)
  const m = scs.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  if (m) { m.scrollTop = 0; return 'SCROLLED' } return 'NO-SCROLLER'
})()`, false))
await sleep(1800)
say('click-edit-first:', await ev(`(() => {
  const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const t = bub.find(e => (((e.querySelector('div[class*="whitespace-pre-wrap"]') || e).textContent) || '').trim().indexOf('测试。输入出1') === 0)
  const b = t && t.querySelector('.qw-edit-btn')
  if (b) { b.click(); return 'CLICKED' } return 'NOT-FOUND bubbles=' + bub.length
})()`, false))
await sleep(1200)
say('confirm-reset:', await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /重置会话/.test(x.textContent || '')); if (b) { b.click(); return 'RESET-CONFIRMED' } return 'NO-MODAL:' + [...document.querySelectorAll('.qw-modal-overlay button')].map(x => x.textContent).join('|').slice(0, 60) })()`, false))
// —— 4. 等重载 + uiEdit 弹窗 → 改文 → 发送 ——
await sleep(9000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
let modal = null
for (let k = 0; k < 10; k++) {
  modal = await ev(`(() => { const ta = document.querySelector('.qw-modal-overlay .qw-modal-text'); return ta ? 'MODAL:' + ta.value.slice(0, 20) : 'NO-MODAL-YET' })()`, false)
  if (modal && modal.startsWith('MODAL')) break
  await sleep(2500)
}
say('uiEdit modal:', modal)
if (!modal || !modal.startsWith('MODAL')) { say('FAIL: 弹窗未出现'); process.exit(1) }
say('send-from-modal:', await ev(`(() => {
  const ta = document.querySelector('.qw-modal-overlay .qw-modal-text')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '测试。输入出2（记验${R}）。记住我的暗号是小红，只回复"收到"')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /发送/.test(x.textContent || ''))
  if (b) { b.click(); return 'SENT' } return 'NO-SEND-BTN'
})()`, false))
const j2 = await waitDone(T, j => j.n >= 2 && j.lastA.indexOf('收') >= 0, 50)
say('round2(重置后):', j2 ? 'n=' + j2.n : 'TIMEOUT')
if (!j2) { process.exit(1) }
// —— 5. 暗号追问（应小红）——
await navTo(T)
say('submit-ask:', await submit(T, '我的暗号是什么？只回答名字'))
const j3 = await waitDone(T, j => /红|明|不知道/.test(j.lastA))
say('暗号回答:', j3 ? JSON.stringify(j3.lastA.slice(0, 30)) : 'TIMEOUT')
const amnesia = !!j3 && /红/.test(j3.lastA) && !/小明/.test(j3.lastA)
// —— 6. 点最后回答 ↻（锚定 REBUILD 自动重发）——
say('click-regen:', await ev(`(() => {
  const as = [...document.querySelectorAll('div[class*="container/assistant-message"]')]
  const last = as[as.length - 1]
  const b = last && (last.querySelector('.qw-regen-btn') || last.querySelector('.qw-regen-end-btn'))
  if (b) { b.click(); return 'CLICKED' } return 'NOT-FOUND as=' + as.length
})()`, false))
await sleep(1200)
say('confirm-regen:', await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /回退并重新生成|重新生成/.test(x.textContent || '')); if (b) { b.click(); return 'CONFIRMED:' + b.textContent } return 'NO-MODAL' })()`, false))
const j4 = await waitDone(T, j => /红|明|不知道/.test(j.lastA) && j.n >= 2, 50)
say('regen 后回答:', j4 ? JSON.stringify(j4.lastA.slice(0, 30)) + ' n=' + j4.n : 'TIMEOUT')
const regenOk = !!j4 && /红/.test(j4.lastA)
// —— 7. 清理 + 回家 ——
say('purge:', await ev(`(async () => { const E = window.__qwEdit; try { const n = await E.permanentDeleteChats([{ id: ${JSON.stringify(T)}, name: '测试输入输出' }], { skipConfirm: true }); return 'PURGED=' + n } catch (e) { return 'FAIL:' + e.message.slice(0, 60) } })()`))
await sleep(2000)
await navTo(HOME)
say('RESULT', amnesia && regenOk ? 'ALL-PASS' : (amnesia ? 'AMNESIA-PASS/REGEN-CHECK' : 'AMNESIA-FAIL') + '/' + (regenOk ? 'REGEN-PASS' : 'REGEN-FAIL'))
const fs = await import('node:fs')
fs.writeFileSync('tools/out-e2e2.json', JSON.stringify({ R, amnesia, regenOk }, null, 1))
try { ws.close() } catch {}
process.exit(amnesia && regenOk ? 0 : 2)
