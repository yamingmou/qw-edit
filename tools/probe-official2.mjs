// 只读探针：检查 2.1.0 官方原生是否提供 编辑/重新生成/分支/删除
const CDP = 'http://127.0.0.1:9222';

async function listPages() {
  const r = await fetch(CDP + '/json');
  return (await r.json()).filter(t => t.type === 'page');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      ws,
      call(method, params = {}, timeout = 15000) {
        return new Promise((res, rej) => {
          const mid = ++id;
          const timer = setTimeout(() => { pending.delete(mid); rej(new Error('cdp timeout ' + method)); }, timeout);
          pending.set(mid, { res, rej, timer });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      evalExpr(expr) {
        return this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
          .then(r => {
            if (r.result && r.result.exceptionDetails) {
              return { __error: r.result.exceptionDetails.text + ' :: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '') };
            }
            return r.result && r.result.result ? r.result.result.value : undefined;
          });
      }
    });
    ws.onerror = e => reject(new Error('ws error'));
  });
}

const pages = await listPages();
const page = pages.find(p => (p.url || '').includes('index.html')) || pages[0];
if (!page) { console.log('NO_PAGE'); process.exit(0); }

const c = await connect(page.webSocketDebuggerUrl);
await c.call('Runtime.enable');

const expr = `(() => {
  const out = { url: location.href, hasQwEdit: !!window.__qwEdit, qwVersion: window.__qwEdit && window.__qwEdit.version };

  // 1) 消息气泡内的按钮：把所有 button/[role=button] 的可读文本/title/aria-label 收集，按容器归类
  const userRows = [...document.querySelectorAll('[class*="container/user-message"], [class*="@container/user-message"]')];
  const asstRows = [...document.querySelectorAll('[class*="container/assistant-message"], [class*="@container/assistant-message"]')];

  const btnInfo = el => {
    const t = (el.textContent || '').trim().slice(0, 24);
    const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
    const cls = (el.className || '').toString().slice(0, 80);
    return { text: t, title, cls };
  };

  const collect = rows => rows.slice(0, 3).map(row => {
    const btns = [...row.querySelectorAll('button, [role="button"]')].map(btnInfo);
    return { btns: btns.slice(0, 20), count: btns.length };
  });

  out.userRows = userRows.length;
  out.asstRows = asstRows.length;
  out.userBtnSamples = collect(userRows);
  out.asstBtnSamples = collect(asstRows);

  // 2) 全文档范围搜索"编辑/重新生成/分支"相关按钮
  const allBtns = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')];
  const keywordHits = [];
  const kw = ['编辑', '重新生成', '分支', '重试', '撤回', '重新回答', '编辑消息', '删除'];
  for (const b of allBtns) {
    const s = ((b.textContent || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
    if (!s) continue;
    if (kw.some(k => s.includes(k))) keywordHits.push({ s: s.slice(0, 40), cls: (b.className || '').toString().slice(0, 60) });
  }
  out.keywordHits = keywordHits.slice(0, 30);

  // 3) 官方注入的按钮特征：我们的是 qw-* 前缀，排除
  out.qwOwned = allBtns.filter(b => /qw-/.test((b.className || '').toString())).length;

  // 4) 侧边栏条目与更多菜单
  out.sidebarText = (() => {
    const aside = document.querySelector('aside') || document.querySelector('[class*="sidebar"]');
    return aside ? aside.innerText.replace(/\\n+/g, ' | ').slice(0, 600) : null;
  })();

  return out;
})()`;

const res = await c.evalExpr(expr);
console.log(JSON.stringify(res, null, 2));
process.exit(0);
