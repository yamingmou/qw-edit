#!/usr/bin/env node
// 第一组对话重新生成测试：单轮会话 → subChat 重建 → 自动重发 → 验证新回答
const PORT = 9222;
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 300000);

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
      const to = setTimeout(() => rej(new Error(method + " timeout")), 280000);
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

    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    if (!chatId) return { err: "create failed" };
    const det = await E.chatDetail(chatId);
    const sub0 = det.subs[0];

    // 第一轮
    await m("agent.submitMessage", { subChatId: sub0.id, chatId, prompt: "只回复两个字：苹果", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    let t1 = null;
    for (let i = 0; i < 80 && !t1; i++) {
      await sleep(3000);
      const msgs = await E.loadMessages(sub0.id);
      const a = msgs.filter(x => x.role === "assistant" && x.sdkMessageUuid);
      const sd = (await q("chats.getSubChat", { id: sub0.id }));
      if (a.length && !(sd?.json ?? sd)?.streamId) t1 = a[0];
    }
    if (!t1) return { ...out, err: "t1 未完成" };
    out.steps.push("t1");
    out.firstAnswer = t1.text.slice(0, 20);

    // 模拟第一组对话「重新生成」：subChat 重建 + 自动重发
    await m("chats.deleteSubChat", { id: sub0.id });
    out.steps.push("deleted");
    const created2 = await m("chats.createSubChat", { chatId, mode: sub0.mode ?? "agent", ...(sub0.modelLevel ? { modelLevel: sub0.modelLevel } : {}) });
    const c2raw = created2;
    const c2 = c2raw?.json ?? c2raw;
    const newId = c2?.id ?? c2?.subChatId ?? (typeof c2 === "string" ? c2 : null);
    if (!newId) return { ...out, err: "createSubChat 返回异常: " + JSON.stringify(created2).slice(0, 250) };
    out.steps.push("recreated");
    out.newSubChatId = newId;

    await sleep(500);
    await m("agent.submitMessage", { subChatId: newId, chatId, prompt: "只回复两个字：苹果", cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
    out.steps.push("resubmitted");

    let t2 = null;
    for (let i = 0; i < 80 && !t2; i++) {
      await sleep(3000);
      const msgs = await E.loadMessages(newId);
      const a = msgs.filter(x => x.role === "assistant");
      const sd = (await q("chats.getSubChat", { id: newId }));
      if (a.length && !(sd?.json ?? sd)?.streamId) t2 = a[0];
    }
    if (!t2) return { ...out, err: "重新生成未完成" };
    out.steps.push("t2-done");
    out.secondAnswer = t2.text.slice(0, 20);
    out.verdict = t2.text.includes("苹果") ? "PASS-第一组重新生成成功" : "FAIL-回答异常";

    try { await m("chats.delete", { id: chatId }); out.steps.push("cleaned"); } catch {}
    return out;
  })()`;

  console.log(await ev(script));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
