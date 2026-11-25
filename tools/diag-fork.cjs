#!/usr/bin/env node
// 诊断：fork 后分支转录文件里到底有什么
const PORT = 9222;
const fs = require("fs");
const path = require("path");
const os = require("os");
setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 300000);

function findSessionFile(sessionId) {
  for (const root of [path.join(os.homedir(), ".qwenworkcn", "projects"), path.join(os.homedir(), ".qoderwork", "projects")]) {
    let dirs; try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(root, d, sessionId + ".jsonl");
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find(x => x.type === "page" && (x.title || "").includes("千问办公"));
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
    if (r.exceptionDetails) throw new Error("EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
    return r.result?.value;
  }

  const script = `(async () => {
    const E = window.__qwEdit;
    const m = E.trpc.bind(null, "mutation");
    const q = E.trpc.bind(null, "query");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const created = await m("chats.create", { projectId: "mu6sy81xrt83thug", chatType: "task" });
    const c = created?.json ?? created;
    const chatId = c?.chatId ?? c?.id;
    const det = await E.chatDetail(chatId);
    const subChatId = det.subs[0].id;
    async function turn(prompt, afterSeq) {
      await m("agent.submitMessage", { subChatId, chatId, prompt, cwd: "process.env.QW_CWD || "/path/to/your/workspace"", historyEnabled: true });
      for (let i = 0; i < 90; i++) {
        await sleep(3000);
        const msgs = await E.loadMessages(subChatId);
        const assist = msgs.filter(x => x.role === "assistant" && x.sequence > afterSeq && x.sdkMessageUuid);
        const sd = await E.subChatState(subChatId);
        if (assist.length && !sd?.streamId) return assist[0];
      }
      return null;
    }
    const t1 = await turn("只回复：好的。", -1);
    if (!t1) return { err: "t1" };
    const t2 = await turn("我叫小明，只回复：好的。", t1.sequence);
    if (!t2) return { err: "t2" };
    const fork = await m("chats.forkFromMessage", { chatId, subChatId, sdkMessageUuid: t1.sdkMessageUuid });
    const f = fork?.json ?? fork;
    if (!f?.subChatId) return { err: "fork failed: " + JSON.stringify(fork).slice(0, 200) };
    const sd = await E.subChatState(f.subChatId);
    return {
      chatId, branchChatId: f.chatId, branchSubChatId: f.subChatId,
      srcSession: det.subs[0].sessionId, branchSession: sd?.sessionId,
      t1uuid: t1.sdkMessageUuid, t2uuid: t2.sdkMessageUuid,
    };
  })()`;
  const r = await ev(script);
  if (r.err) { console.log("ERR:", r.err); process.exit(1); }
  console.log("== fork 结果 ==", JSON.stringify(r, null, 2));

  const srcFile = findSessionFile(r.srcSession);
  const braFile = findSessionFile(r.branchSession);
  console.log("\n== 文件 ==");
  console.log("src:", srcFile, srcFile ? fs.readFileSync(srcFile, "utf8").split("\n").filter(Boolean).length + " lines" : "NOT FOUND");
  console.log("branch:", braFile, braFile ? fs.readFileSync(braFile, "utf8").split("\n").filter(Boolean).length + " lines" : "NOT FOUND");

  if (braFile) {
    const lines = fs.readFileSync(braFile, "utf8").split("\n").filter(Boolean);
    console.log("\n== 分支文件逐行（type + 前120字）==");
    lines.forEach((l, i) => {
      let preview = l.slice(0, 120);
      try {
        const j = JSON.parse(l);
        preview = `[type=${j.type ?? "?"}] ` + JSON.stringify(j).slice(0, 150);
      } catch {}
      console.log(String(i + 1).padStart(3), preview);
      if (l.includes("小明")) console.log("    ^^^ 含「小明」!");
    });
  }
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
