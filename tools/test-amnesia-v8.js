#!/usr/bin/env node
// v8 失忆测试：走真实 rewindToBranch 路径（fork + 文件验证）
// 流程：t1(无信息) → t2("我叫小明") → t3(问名字→小明)
//      → rewindToBranch(锚=t1回答) → t4("我叫小红") → t5(问名字→必须小红、不知小明)
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
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
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
    out.srcSession = det.subs[0].sessionId;

    async function waitTurn(sub, afterSeq) {
      for (let i = 0; i < 90; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(sub);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const sd = await E.subChatState(sub);
        if (assist.length && !sd?.streamId) return assist[0];
      }
      return null;
    }
    async function turn(sub, chat, prompt, afterSeq) {
      await m("agent.submitMessage", { subChatId: sub, chatId: chat, prompt, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
      return waitTurn(sub, afterSeq);
    }
    async function lastAnswer(sub, afterSeq) {
      const msgs = await E.loadMessages(sub);
      return (msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq).slice(-1)[0] || {}).text || "";
    }

    const t1 = await turn(subChatId, chatId, "只回复：好的。", -1);
    if (!t1) return { ...out, err: "t1 未完成" }; say("t1");
    const t2 = await turn(subChatId, chatId, "我叫小明，只回复：好的。", t1.sequence);
    if (!t2) return { ...out, err: "t2 未完成" }; say("t2");
    const t3 = await turn(subChatId, chatId, "我叫什么？只回复名字。", t2.sequence);
    if (!t3) return { ...out, err: "t3 未完成" }; say("t3");
    out.beforeRewind = (await lastAnswer(subChatId, t2.sequence)).slice(0, 30); // 应含 小明

    // ===== 走真实 rewindToBranch：锚 = t1 的回答（截断 t2 之后的一切）=====
    out.rewind = await E.rewindToBranch({
      chatId, subChatId,
      anchor: { sdkMessageUuid: t1.sdkMessageUuid },
      forbiddenTexts: ["我叫小明"],
    });
    say("rewind");
    if (!out.rewind?.branchChatId) return { ...out, err: "rewind failed" };
    const bSub = out.rewind.branchSubChatId, bChat = out.rewind.branchChatId;

    // t4：在分支里提交"我叫小红"
    const t4 = await turn(bSub, bChat, "我叫小红，只回复：好的。", -1);
    if (!t4) return { ...out, err: "t4(编辑后) 未完成" }; say("t4-edited");
    const t5 = await turn(bSub, bChat, "我叫什么？只回复名字。另外如果我之前告诉过你别的名字，请说出来。", t4.sequence);
    if (!t5) return { ...out, err: "t5 未完成" }; say("t5");
    out.afterRewind = (await lastAnswer(bSub, t4.sequence)).slice(0, 80); // 应为 小红，且不知小明

    // 清理：软删除两个测试会话
    try { await m("chats.delete", { id: bChat }); say("branch-cleaned"); } catch {}
    try { await m("chats.delete", { id: chatId }); say("src-cleaned"); } catch {}
    const a = out.afterRewind || "";
    out.verdict = a.includes("小红") && !a.includes("小明") ? "PASS-真撤回生效" : "FAIL-上下文泄漏";
    return out;
  })()`;

  console.log(JSON.stringify(await ev(script), null, 2));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
