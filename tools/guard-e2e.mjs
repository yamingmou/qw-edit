// 1.4.0 era-guard E2E：opencode 会话点 ✎/↻ → 只弹说明+回填，投影零变化、不重发
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const call = (method, params = {}, timeout = 45000) => new Promise((res, rej) => {
  const i = ++id
  const t = setTimeout(() => rej(new Error('timeout')), timeout)
  pend.set(i, r => { clearTimeout(t); res(r) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300)
  return r.result?.result?.value
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const SUB = 'mvtdtob8nfwfbs70', CHAT = 'mvtdtob8ap5uziz4'
const out = {}

// 导航：先离开当前会话再点回测试会话（强制点走点回，避免同名歧义）
const nav = await ev(`(async () => {
  const E = window.__qwEdit
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const devRow = E.sidebarItemsByName('插件开发者')[0]
  if (devRow) devRow.click(); await sleep(1200)
  const row = E.sidebarItemsByName('记住口令').find(el => !(el.textContent||'').includes(' 2'))
  if (!row) return 'NOROW'
  row.click()
  for (let t = 0; t < 20; t++) { await sleep(400); if (E.currentChatId() === '${CHAT}') return 'ONCHAT' }
  return 'WRONG:' + E.currentChatId()
})()`)
out.nav = nav
if (nav !== 'ONCHAT') { console.log(JSON.stringify(out)); process.exit(1) }
await sleep(1500)

const baseN = await ev(`(async()=>{ const E=window.__qwEdit; return JSON.stringify((await E.loadMessages('${SUB}')).length) })()`)
out.baseN = JSON.parse(baseN)

// 守卫断言：最后一条用户气泡必须存在 ✎
const clickEdit = await ev(`(() => {
  const E = window.__qwEdit
  if (E.currentChatId() !== '${CHAT}') return 'GUARD-ABORT'
  const bubbles = [...document.querySelectorAll('div[class*="container/user-message"]')]
  const last = bubbles[bubbles.length - 1]
  const btn = last && last.querySelector('.qw-edit-btn')
  if (!btn) return 'NOBTN'
  btn.click()
  return 'CLICKED'
})()`)
out.clickEdit = clickEdit
await sleep(2500)

// 模态应出现（无法安全回退），抓文本后点“知道了”，再校验投影未动 + composer 已回填
const modalCheck = await ev(`(async () => {
  const ov = document.querySelector('.qw-modal')
  const title = ov?.querySelector('.qw-modal-title')?.textContent || 'NO-MODAL'
  const body = (ov?.querySelector('.qw-modal-body')?.textContent || '').slice(0, 40)
  const okBtn = ov?.querySelector('[data-act="ok"]')
  if (okBtn) okBtn.click()
  const comp = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  return JSON.stringify({ title, body, composerHasText: (comp ? (comp.value ?? comp.textContent ?? '') : '').includes('BETA') })
})()`)
out.modalEdit = JSON.parse(modalCheck)
await sleep(1200)
const nAfterEdit = await ev(`(async()=>JSON.stringify((await window.__qwEdit.loadMessages('${SUB}')).length))()`)
out.nAfterEdit = JSON.parse(nAfterEdit)

// 清空 composer 残留，点 ↻（最后一条回答）
const clickRegen = await ev(`(async () => {
  const E = window.__qwEdit
  const comp = document.querySelector("textarea:not([readonly]), [contenteditable='true']")
  if (comp) {
    const set = Object.getOwnPropertyDescriptor(comp.tagName === 'TEXTAREA' ? comp.constructor.prototype : HTMLElement.prototype, comp.tagName === 'TEXTAREA' ? 'value' : 'textContent')
    if (set?.set) { set.set.call(comp, ''); comp.dispatchEvent(new Event('input', { bubbles: true })) }
  }
  if (E.currentChatId() !== '${CHAT}') return 'GUARD-ABORT'
  const bubbles = [...document.querySelectorAll('div[class*="container/assistant-message"]')]
  const last = bubbles[bubbles.length - 1]
  const btn = last && (last.querySelector('.qw-regen-btn'))
  if (!btn) return 'NOBTN'
  btn.click()
  return 'CLICKED'
})()`)
out.clickRegen = clickRegen
await sleep(2500)
const modalCheck2 = await ev(`(async () => {
  const ov = document.querySelector('.qw-modal')
  const title = ov?.querySelector('.qw-modal-title')?.textContent || 'NO-MODAL'
  const okBtn = ov?.querySelector('[data-act="ok"]')
  if (okBtn) okBtn.click()
  return JSON.stringify({ title })
})()`)
out.modalRegen = JSON.parse(modalCheck2)

// 等 15 秒确认没有任何自动重发发生
await sleep(15000)
const nFinal = await ev(`(async()=>{const E=window.__qwEdit;const sd=await E.subChatState('${SUB}');return JSON.stringify({n:(await E.loadMessages('${SUB}')).length, streaming: !!sd?.streamId})})()`)
out.afterRegen = JSON.parse(nFinal)

out.verdict = (
  out.modalEdit.title === '无法安全回退' && out.modalEdit.composerHasText &&
  out.nAfterEdit === out.baseN &&
  out.modalRegen.title === '无法安全重新生成' &&
  out.afterRegen.n === out.baseN && !out.afterRegen.streaming
) ? 'PASS：拒绝路径正确，零破坏、零假重发' : 'FAIL'
console.log(JSON.stringify(out, null, 1))
ws.close()
process.exit(0)
