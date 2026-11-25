// M3 专项：首条 ✎ → 重置 → uiEdit 弹窗 → 点取消 → 应弹 uiPrompt 留存原文（可复制）
const sleep = ms => new Promise(r => setTimeout(r, ms))
const R = '取验' + Math.random().toString(36).slice(2, 6)
const HOME = 'mvfhzb4t961plcac'
const say = (...a) => console.log(a.join(' '))
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
      if (ex) return 'EX:' + JSON.stringify(ex.exception?.description || ex.text).slice(0, 120)
    } catch {}
    await sleep(2500); try { ws.close() } catch {}; await open(); await call('Runtime.enable')
  }
  return null
}
await call('Runtime.enable')
const bridgeUp = async () => { for (let k = 0; k < 20; k++) { if (await ev(`window.__qwEdit?'UP':'D'`, false) === 'UP') return true; await sleep(1500) } return false }
// 1. 建会话 + 一轮
const created = await ev(`(async () => {
  const E = window.__qwEdit
  const home = await E.chatDetail('${HOME}')
  const pid = home.chat && (home.chat.projectId || home.chat.localProjectId)
  const c = await E.trpc('mutation', 'chats.create', { projectId: pid })
  const cc = (c && c.json) ? c.json : c
  const cid = cc && (cc.id || (cc.chat && cc.chat.id))
  if (!cid) return 'NOID'
  const d = await E.chatDetail(cid)
  return JSON.stringify({ cid, sid: d.subs[0] && d.subs[0].id })
})()`)
say('create:', created)
const { cid, sid } = JSON.parse(created)
await ev(`(async () => { await window.__qwEdit.apiSubmit({ subChatId: ${JSON.stringify(sid)}, chatId: ${JSON.stringify(cid)}, prompt: ${JSON.stringify(R + '。说一个字：好')}, cwd: '', mode: 'agent' }) })()`)
for (let k = 0; k < 20; k++) {
  await sleep(3000)
  const done = await ev(`(async () => { const all = await window.__qwEdit.loadMessages(${JSON.stringify(sid)}, { maxPages: 3 }); return all.filter(x => x.role === 'assistant').length })()`)
  if (done >= 1) break
}
// 2. 导航 + 渲染等待
await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: ${JSON.stringify(cid)} })`, false)
await sleep(8000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
let rendered = 0
for (let k = 0; k < 12; k++) {
  rendered = await ev(`document.querySelectorAll('div[class*="container/user-message"]').length`, false)
  if (rendered > 0) break
  await sleep(2500)
}
say('rendered bubbles:', rendered)
if (!rendered) { say('FAIL: 视图未渲染'); process.exit(1) }
// 3. 点首条 ✎ → 重置 → 等 uiEdit 弹窗
say('click:', await ev(`(() => {
  const bub = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const t = bub.find(e => (((e.querySelector('div[class*="whitespace-pre-wrap"]') || e).textContent) || '').trim().indexOf(${JSON.stringify(R)}) === 0)
  const b = t && t.querySelector('.qw-edit-btn')
  if (b) { b.click(); return 'CLICKED' } return 'NOT-FOUND'
})()`, false))
await sleep(1200)
say('confirm:', await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /重置会话/.test(x.textContent || '')); if (b) { b.click(); return 'YES' } return 'NO-MODAL' })()`, false))
await sleep(9000); try { ws.close() } catch {}; await open(); await call('Runtime.enable'); await bridgeUp()
let modal = 'NO'
for (let k = 0; k < 12; k++) {
  modal = await ev(`(() => { const ta = document.querySelector('.qw-modal-overlay .qw-modal-text'); return ta ? 'MODAL:' + ta.value.slice(0, 10) : 'WAIT' })()`, false)
  if (typeof modal === 'string' && modal.startsWith('MODAL')) break
  await sleep(2500)
}
say('uiEdit:', modal)
// 4. 点取消 → 应出现 uiPrompt（含"复制原文"）留存
say('cancel:', await ev(`(() => { const b = [...document.querySelectorAll('.qw-modal-overlay button')].find(x => /取消/.test(x.textContent || '')); if (b) { b.click(); return 'CANCELLED' } return 'NO-CANCEL-BTN' })()`, false))
await sleep(2500)
const kept = await ev(`(() => { const ov = document.querySelector('.qw-modal-overlay'); if (!ov) return 'NO-OVERLAY'; const ok = /复制原文|留存/.test(ov.textContent || ''); return (ok ? 'PROMPT-KEPT:' : 'WRONG-MODAL:') + (ov.textContent || '').slice(0, 40) })()`, false)
say('M3 留存检查:', kept)
// 5. 清理回家
say('purge:', await ev(`(async () => { try { return 'PURGED=' + await window.__qwEdit.permanentDeleteChats([{ id: ${JSON.stringify(cid)}, name: '取验' }], { skipConfirm: true }) } catch (e) { return 'FAIL' } })()`))
await sleep(2000)
await ev(`window.desktopApi && window.desktopApi.openMainWindowWithChat({ chatId: '${HOME}' })`, false)
const pass = typeof kept === 'string' && kept.startsWith('PROMPT-KEPT')
say('RESULT', pass ? 'M3-PASS' : 'M3-FAIL')
try { ws.close() } catch {}
process.exit(pass ? 0 : 1)
