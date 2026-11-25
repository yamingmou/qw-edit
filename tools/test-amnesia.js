#!/usr/bin/env node
// 精确失忆测试：信息在被撤回的轮次里，编辑重发后模型必须"失忆"
// 流程：t1(无信息) → t2("我叫小明") → t3(问名字→小明) → [编辑t2改成"我叫小红"] → t4(问名字→必须答小红且不提小明)
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
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
    return r.result?.value;
  }

  const script = `(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { steps: [] };
    const say = (k) => out.steps.push(k);

    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    if (!chatId) return { ...out, err: "create failed" };
    const det = await E.chatDetail(chatId);
    const subChatId = det.subs[0].id;

    async function waitTurn(afterSeq) {
      for (let i = 0; i < 80; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const subD = (await q("chats.getSubChat", { id: subChatId }));
        const sd = subD?.json ?? subD;
        if (assist.length && !sd?.streamId) return assist[0];
      }
      return null;
    }
    async function turn(prompt, afterSeq) {
      await m("agent.submitMessage", { subChatId, chatId, prompt, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
      return waitTurn(afterSeq);
    }
    async function lastAnswer(afterSeq) {
      const msgs = await E.loadMessages(subChatId);
      return (msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq).slice(-1)[0] || {}).text || "";
    }

    const t1 = await turn("只回复：好的。", -1);
    if (!t1) return { ...out, err: "t1 未完成" }; say("t1");
    const t2 = await turn("我叫小明，只回复：好的。", t1.sequence);
    if (!t2) return { ...out, err: "t2 未完成" }; say("t2");
    const t3 = await turn("我叫什么？只回复名字。", t2.sequence);
    if (!t3) return { ...out, err: "t3 未完成" }; say("t3");
    out.beforeEdit = (await lastAnswer(t2.sequence)).slice(0, 30); // 应为 小明

    // 模拟「编辑重发 t2」：新 trueRollback（截断投影 + 换新 sessionId）
    const rb = await m("chats.rollbackToMessage", { subChatId, sdkMessageUuid: t1.sdkMessageUuid }); say("ui-rollback");
    const freshId = crypto.randomUUID();
    await m("chats.updateSubChatSession", { id: subChatId, sessionId: freshId }); say("repoint-fresh");

    // 提交修改后的消息
    await sleep(800);
    const t4 = await turn("我叫小红，只回复：好的。", t1.sequence);
    if (!t4) return { ...out, err: "t4(编辑后) 未完成" }; say("t4-edited");
    const t5 = await turn("我叫什么？只回复名字。另外如果我之前告诉过你别的名字，请说出来。", t4.sequence);
    if (!t5) return { ...out, err: "t5 未完成" }; say("t5");
    out.afterEdit = (await lastAnswer(t4.sequence)).slice(0, 60); // 应为 小红，且不应知道小明

    // 清理
    try { await m("chats.delete", { id: chatId }); say("cleaned"); } catch {}
    out.verdict = out.afterEdit.includes("小红") && !out.afterEdit.includes("小明") ? "PASS-真撤回生效" : "FAIL-上下文泄漏";
    return out;
  })()`;

  console.log(await ev(script));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
