#!/usr/bin/env node
// 复现 qw-edit「重新生成」完整流程（一次性测试会话，不碰现有会话）
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
      const to = setTimeout(() => rej(new Error(method + " timeout")), 120000);
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
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
    return r.result?.value;
  }

  const script = `(async () => {
    const E = window.__qwEdit;
    const q = E.trpc.bind(null, "query");
    const m = E.trpc.bind(null, "mutation");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { steps: [] };
    const say = (k, v) => { out.steps.push(k); console.log("[test]", k, v ?? ""); };

    // 1. 建测试会话
    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", name: "qw-edit-自动测试", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    say("create", chatId);
    if (!chatId) return { ...out, err: "create failed: " + JSON.stringify(created).slice(0, 200) };

    const det = await E.chatDetail(chatId);
    const sub = det.subs[0];
    const subChatId = sub.id;

    // 等一轮完成
    async function waitTurn(subChatId, afterSeq) {
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const subD = (await q("chats.getSubChat", { id: subChatId }))?.json;
        if (assist.length && !subD?.streamId) return { assist: assist[0], msgs };
      }
      return null;
    }

    // 2. 第一轮：让模型记住暗号
    say("submit1");
    await m("agent.submitMessage", { subChatId, chatId, prompt: "记住暗号是西瓜。只回复：好的。", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    const t1 = await waitTurn(subChatId, -1);
    if (!t1) return { ...out, err: "turn1 未完成" };
    say("turn1 done", "anchor uuid " + t1.assist.sdkMessageUuid.slice(0, 8));

    // 3. 第二轮：问暗号（应答出西瓜）
    say("submit2");
    await m("agent.submitMessage", { subChatId, chatId, prompt: "暗号是什么？只回复暗号本身。", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    const t2 = await waitTurn(subChatId, t1.assist.sequence);
    if (!t2) return { ...out, err: "turn2 未完成" };
    const msgsBefore = await E.loadMessages(subChatId);
    const ans2 = msgsBefore.filter(x => x.role === "assistant" && x.sequence > t1.assist.sequence).slice(-1)[0];
    say("turn2 done", "回答: " + (ans2?.text || "").slice(0, 30));

    // 4. 模拟「重新生成」点击：trueRollback + 重发
    const anchor = t1.assist;
    try {
      const fork = await m("chats.forkFromMessage", { chatId, subChatId, sdkMessageUuid: anchor.sdkMessageUuid });
      const f = fork?.json ?? fork;
      say("fork", JSON.stringify({ chatId: f?.chatId, subChatId: f?.subChatId }).slice(0, 120));
      if (!f?.subChatId) return { ...out, err: "fork 返回异常: " + JSON.stringify(fork).slice(0, 300) };
      const branchRaw = await q("chats.getSubChat", { id: f.subChatId }); const branchSub = branchRaw?.json ?? branchRaw;
      say("branch session", branchSub?.sessionId);
      if (!branchSub?.sessionId) return { ...out, err: "分叉会话无 sessionId" };
      await m("chats.updateSubChatSession", { id: subChatId, sessionId: branchSub.sessionId });
      say("repointed");
      const rb = await m("chats.rollbackToMessage", { subChatId, sdkMessageUuid: anchor.sdkMessageUuid });
      say("ui-rollback", JSON.stringify(rb).slice(0, 120));
      await m("chats.delete", { id: f.chatId });
      say("branch-cleaned");
    } catch (e) {
      return { ...out, err: "rollback 阶段失败: " + String(e).slice(0, 400) };
    }

    // 5. 重发原提问
    await sleep(800);
    say("resubmit");
    try {
      await m("agent.submitMessage", { subChatId, chatId, prompt: "暗号是什么？只回复暗号本身。", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    } catch (e) {
      return { ...out, err: "resubmit 失败: " + String(e).slice(0, 400) };
    }
    const t3 = await waitTurn(subChatId, anchor.sequence);
    if (!t3) return { ...out, err: "turn3 未完成" };
    const msgsAfter = await E.loadMessages(subChatId);
    const ans3 = msgsAfter.filter(x => x.role === "assistant" && x.sequence > anchor.sequence).slice(-1)[0];
    say("turn3 done", "新回答: " + (ans3?.text || "").slice(0, 40));
    out.beforeAnswer = (ans2?.text || "").slice(0, 60);
    out.afterAnswer = (ans3?.text || "").slice(0, 60);
    out.forgetPassword = !(ans3?.text || "").includes("西瓜");

    // 6. 清理测试会话
    try { await m("chats.delete", { id: chatId }); say("test-chat-cleaned"); } catch (e) { out.cleanupErr = String(e).slice(0, 120); }
    return out;
  })()`;

  console.log(await ev(script));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
