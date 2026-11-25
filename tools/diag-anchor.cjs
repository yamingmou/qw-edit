#!/usr/bin/env node
// 诊断：投影 metadata 的 uuid vs 转录行的 uuid 对照
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
    const t2 = await turn("我叫小明，只回复：好的。", t1.sequence);
    if (!t2) return { err: "t2" };
    // 拉原始投影（含完整 metadata）
    const raw = await q("chats.listBySubChat", { subChatId, limit: 200 });
    const list = Array.isArray(raw) ? raw : (raw?.messages ?? []);
    const sd = await E.subChatState(subChatId);
    return {
      chatId, subChatId, sessionId: sd?.sessionId,
      projection: list.map(x => ({
        seq: x.sequence, role: x.role, id: x.id,
        meta: { uuid: x.metadata?.sdkMessageUuid, uuids: x.metadata?.sdkMessageUuids, status: x.metadata?.status, taskStatus: x.metadata?.taskStatus },
        text: (x.parts || x.content || []).map ? (x.parts || x.content).filter(p => p?.type === "text").map(p => p.text).join("").slice(0, 40) : String(x.parts).slice(0, 40),
      })),
    };
  })()`;
  const r = await ev(script);
  if (r.err) { console.log("ERR:", r.err); process.exit(1); }
  console.log("sessionId:", r.sessionId);
  console.log("\n== 投影 ==");
  r.projection.forEach(p => console.log(JSON.stringify(p)));
  const f = findSessionFile(r.sessionId);
  console.log("\n== 转录文件:", f);
  if (f) fs.readFileSync(f, "utf8").split("\n").filter(Boolean).forEach((l, i) => {
    try {
      const j = JSON.parse(l);
      const c = j.message?.content;
      const texts = Array.isArray(c) ? c.filter(p => p?.type === "text").map(p => p.text) : [];
      console.log(String(i + 1).padStart(3), j.type, "uuid=" + (j.uuid || "").slice(0, 8), "msgId=" + String(j.message?.id || "").slice(0, 14), "text=" + JSON.stringify(texts.join("").slice(0, 30)));
    } catch { console.log(i + 1, "PARSE-ERR", l.slice(0, 60)); }
  });
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
