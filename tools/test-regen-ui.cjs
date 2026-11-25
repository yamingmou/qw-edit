#!/usr/bin/env node
// 诊断：trueRollback + submit 后渲染层是否更新；openMainWindowWithChat 重绑能否显示新回答
// 全程用一次性测试 chat，结束导航回原会话
const PORT = 9222;
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 420000);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
  if (!t) throw new Error("no page target");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let idc = 0;
  function call(method, params) {
    return new Promise((res, rej) => {
      const id = ++idc;
      const to = setTimeout(() => rej(new Error(method + " timeout")), 400000);
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to); ws.removeEventListener("message", h);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expression) {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600));
    return r.result?.value;
  }

  const script = `(async () => {
    const E = window.__qwEdit;
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { steps: [] };
    const say = (k) => out.steps.push(k);
    const domHas = (s) => document.body.innerText.includes(s);
    const nav = (chatId, subChatId) => window.desktopApi?.openMainWindowWithChat?.({ chatId, subChatId });

    // Phase A：识别当前可见会话（测试后导航回来）
    const els = [...document.querySelectorAll('div[class*="container/assistant-message"] div[class*="whitespace-pre-wrap"], div[class*="container/assistant-message"] p')];
    const lastTxt = (els[els.length - 1]?.textContent || "").slice(0, 30);
    const hits = await E.findMessages(lastTxt, { role: "assistant", mode: "prefix" });
    const origin = E.pinHits(hits);
    if (!origin) return { ...out, err: "origin not found" };
    out.origin = { chatId: origin.chat.id, subChatId: origin.sub.id };
    say("origin-found");

    // Phase B：一次性测试会话，两轮
    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    const det = await E.chatDetail(chatId);
    const subChatId = det.subs[0].id;
    async function waitTurn(afterSeq) {
      for (let i = 0; i < 90; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const sd = await E.subChatState(subChatId);
        if (assist.length && !sd?.streamId) return assist[0];
      }
      return null;
    }
    async function turn(prompt, afterSeq) {
      await m("agent.submitMessage", { subChatId, chatId, prompt, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
      return waitTurn(afterSeq);
    }
    const t1 = await turn("只回复：好的。", -1);
    if (!t1) return { ...out, err: "t1" };
    const t2 = await turn("我叫小明，只回复：好的。", t1.sequence);
    if (!t2) return { ...out, err: "t2" };
    say("turns-done");

    // Phase C：导航到测试会话，验证 DOM 可见
    await nav(chatId, subChatId);
    await sleep(2500);
    out.domAfterNav = { xiaoming: domHas("我叫小明"), hao: domHas("好的") };
    say("nav-test-chat");

    // Phase D：trueRollback（锚=t1 回答，截断 t2 之后）——观察 DOM 是否自动刷新
    const all = await E.loadMessages(subChatId);
    out.rewind = await E.trueRollback({
      subChatId,
      anchor: { sdkMessageUuid: t1.sdkMessageUuid, sequence: t1.sequence, text: t1.text },
      all, forbiddenTexts: ["我叫小明"],
    });
    say("rewind");
    await sleep(3000);
    out.domAfterRewind = { xiaoming: domHas("我叫小明") };
    // DOM 不更新则重绑后再看
    if (out.domAfterRewind.xiaoming) {
      await nav(chatId, subChatId);
      await sleep(2500);
      out.domAfterRewindRebind = { xiaoming: domHas("我叫小明") };
      say("rebind-after-rewind");
    }

    // Phase E：提交新消息（模拟编辑重发后的发送）——观察 DOM
    await m("agent.submitMessage", { subChatId, chatId, prompt: "我叫小红，只回复：好的。", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    say("submitted");
    for (let i = 0; i < 5; i++) { await sleep(3000); if (domHas("我叫小红")) break; }
    out.domAfterSubmit = { xiaohong: domHas("我叫小红") };

    // Phase F：重绑，观察新回答是否显示（含流式迹象：文本变长）
    await nav(chatId, subChatId);
    let lastLen = -1, growth = [];
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const len = document.body.innerText.length;
      growth.push(len);
      const done = await (async () => {
        const sd = await E.subChatState(subChatId);
        return !sd?.streamId;
      })();
      if (done && i > 1) break;
    }
    out.domAfterRebind = {
      xiaohong: domHas("我叫小红"),
      xiaoming: domHas("我叫小明"),
      lenGrowth: growth.slice(0, 8).join(","),
    };
    // 等 answer 完成
    const t4 = await waitTurn(-1);
    out.finalAnswer = t4 ? t4.text.slice(0, 30) : null;

    // Phase G：清理 + 导航回原会话
    try { await m("chats.delete", { id: chatId }); say("cleaned"); } catch {}
    await nav(out.origin.chatId, out.origin.subChatId);
    await sleep(1500);
    out.restored = true;
    return out;
  })()`;

  console.log(JSON.stringify(await ev(script), null, 2));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
