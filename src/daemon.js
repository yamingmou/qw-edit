#!/usr/bin/env node
/**
 * qw-edit daemon — CDP 注入守护进程（生命周期跟随客户端）
 *
 * 设计原则：注入脚本之外零动作，不直接读写客户端任何数据。
 *
 * 生命周期（配合平台调度）：
 *  - macOS：launchd KeepAlive + ThrottleInterval，每 10s 拉起做毫秒级检查
 *  - Windows：任务计划程序每分钟拉起一次（daemon-run.vbs 隐藏窗口）
 *  - 客户端未运行 → 立即退出（等下一轮拉起，机器上无常驻进程）
 *  - 客户端运行且带调试端口 → 常驻，注入并保持
 *  - 客户端运行但无端口 → 弹询问框，用户同意才带端口重启（拒绝则本次运行不再问）
 *  - 客户端退出（CDP 消失）→ 退出，等下一轮拉起
 */
import { readFile, readdir, stat as statFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const CDP_PORT = 9222;
const POLL_MS = 3000;
const EXIT_GRACE_MS = 15000; // CDP 消失后宽限，防 app 重启间隙误退出
const APP_NAME = "QwenWorkCN"; // macOS 应用进程名（pgrep -x 精确匹配）；Windows 上为 QwenWorkCN.exe
const MARKER = path.join(tmpdir(), "qw-edit-relaunch.marker");
const CONFIG_PATH = path.join(homedir(), ".qw-edit", "config.json");
const INJECT_PATH = new URL("./inject.js", import.meta.url);
const LOCK_PATH = path.join(homedir(), ".qw-edit", "daemon.lock");
const LOG_PATH = path.join(homedir(), ".qw-edit", "daemon.log");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const config = { takeover: true, maxFailedTakeovers: 3 };
try { Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, "utf8"))); } catch {}

const injected = new Set(); // 已废弃，保留兼容
let lastRelaunchAt = 0;
let failedTakeovers = 0;
let asking = false; // 弹框进行中标志：防并发弹框 / 防重入
if (existsSync(MARKER)) { try { lastRelaunchAt = Number(readFileSync(MARKER, "utf8")) || 0; } catch {} }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 日志：同时写控制台与 ~/.qw-edit/daemon.log（Windows 无 launchd 重定向，靠它留痕） */
function fileLog(s) {
  try { mkdirSync(path.dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, s + "\n"); } catch {}
}
const log = (...a) => {
  const s = `[daemon ${new Date().toISOString().slice(11, 19)}] ${a.map(String).join(" ")}`;
  console.log(s);
  fileLog(s);
};
const dbg = (...a) => { if (process.env.QW_EDIT_DEBUG === "1") console.log("[dbg]", ...a); };

/* ---------- 进程探测（跨平台） ---------- */
function appPids() {
  try {
    if (IS_WIN) {
      const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${APP_NAME}.exe`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const pids = [];
      for (const line of out.split("\n")) {
        const m = new RegExp(`"${APP_NAME}\\.exe","(\\d+)"`).exec(line);
        if (m) pids.push(m[1]);
      }
      return pids;
    }
    return execFileSync("pgrep", ["-x", APP_NAME]).toString().split("\n").filter(Boolean);
  } catch { return []; }
}
/* Windows：一次 PowerShell 批量取所有进程已运行秒数（避免逐进程启动 PS 的开销） */
function appUptimes(pids) {
  if (!pids.length) return [];
  if (IS_WIN) {
    try {
      const out = execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `$ids = @(${pids.join(",")}); foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { [int]((Get-Date) - $p.StartTime).TotalSeconds }`],
        { encoding: "utf8", timeout: 5000 });
      return (out || "").trim().split(/\r?\n/).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
    } catch { return pids.map(() => 0); }
  }
  return pids.map(appUptime);
}
function appUptime(pid) {
  // macOS BSD ps：etime 格式为 [[dd-]hh:]mm:ss
  try {
    const s = execFileSync("ps", ["-o", "etime=", "-p", pid]).toString().trim();
    const parts = s.split(/[-:]/).map(Number);
    if (parts.some(isNaN)) return 0;
    const [d = 0, h = 0, m = 0, sec = 0] = parts.length === 4 ? parts : [0, ...parts];
    return d * 86400 + h * 3600 + m * 60 + sec;
  } catch { return 0; }
}
/* Windows：从运行中的主进程解析可执行文件路径（kill 后拿不到，必须 kill 前取） */
function winAppExePath(pid) {
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
      { encoding: "utf8", timeout: 5000 });
    return (out || "").trim() || null;
  } catch { return null; }
}
async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/* ---------- takeover：无端口运行 → 询问用户，同意才重启加载 ----------
 * 不再擅自重启。检测到"客户端在跑但没带调试端口"时弹系统询问框：
 *   立即重启 → 结束无端口实例并带端口重开（用户已明确同意，直接结束，
 *              不再走会二次弹"确认退出"框的优雅退出）
 *   暂不     → 本次运行期间不再询问（按进程组记忆，尊重用户选择）
 * 60 秒无响应视为"暂不"。 */
const ASKED_PATH = path.join(homedir(), ".qw-edit", "asked.json");
let askedRuns = {};
try { askedRuns = JSON.parse(readFileSync(ASKED_PATH, "utf8")) || {}; } catch {}

/* 原子写（tmp+rename）：进程中断不会留下半截文件 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
const askedFileWrite = () => { try { atomicWrite(ASKED_PATH, JSON.stringify(askedRuns)); } catch {} };

/* 单实例锁：防止调度器拉起第二个 daemon 叠加弹框；持有弹框子进程引用，
 * daemon 退出时清理孤儿弹框 */
const acquireLock = () => {
  try {
    if (existsSync(LOCK_PATH)) {
      const pid = Number(readFileSync(LOCK_PATH, "utf8"));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; }      // 存活实例持有锁
        catch (e) { if (e.code !== "ESRCH") return false; } // EPERM 也视为存活
      }
    }
    atomicWrite(LOCK_PATH, String(process.pid));
    return true;
  } catch { return false; }
};
const releaseLock = () => {
  try {
    if (readFileSync(LOCK_PATH, "utf8") === String(process.pid)) unlinkSync(LOCK_PATH);
  } catch {}
};
let currentAskChild = null;
const killOrphanDialog = () => { try { currentAskChild?.kill("SIGKILL"); } catch {} currentAskChild = null; };
process.on("exit", releaseLock);
process.on("SIGTERM", () => { killOrphanDialog(); releaseLock(); process.exit(0); });
process.on("SIGINT", () => { killOrphanDialog(); releaseLock(); process.exit(0); });

function runKey(pids) { return pids.slice().sort().join(","); }

function askRestartDialog() {
  if (IS_WIN) {
    // Windows：WScript.Shell.Popup 原生支持超时；返回 6=是(立即重启) 7=否(暂不) -1=超时
    return new Promise((resolve) => {
      let done = false;
      // JS 里的 \n 会被 PowerShell 单引号字符串原样保留为真实换行；用反引号转义在单引号串里不生效
      const text = "「编辑撤回 / 重新生成」尚未加载到千问办公。\n\n需要重启千问办公来加载（正在运行的任务会被中断）。\n选「否」则本次运行不再询问。";
      const ps = `$w = New-Object -ComObject WScript.Shell; $r = $w.Popup('${text}', 60, 'qw-edit 加载器', 4 + 32); Write-Output $r`;
      const enc = Buffer.from(ps, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc]);
      currentAskChild = child;
      let out = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90_000);
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (currentAskChild === child) currentAskChild = null; resolve(v); };
      child.stdout?.on("data", (d) => { out += d; });
      child.on("close", (code) => {
        const n = Number((out || "").trim());
        finish(code === 0 && n === 6);
        if (!done) return;
      });
      child.on("error", (e) => { log("ask dialog 启动失败:", e.message); finish(false); });
    });
  }
  // 非阻塞 spawn：弹框期间轮询不能停摆；90s 兜底超时防 osascript 意外挂起
  return new Promise((resolve) => {
    let done = false;
    const script =
      'display dialog "「编辑撤回 / 重新生成」尚未加载到千问办公。" & return & ' +
      '"需要重启千问办公来加载（正在运行的任务会被中断）。" & return & return & ' +
      '"选「暂不」则本次运行不再询问。" with title "qw-edit 加载器" buttons {"暂不", "立即重启"} default button "暂不" cancel button "暂不" giving up after 60';
    const child = spawn("osascript", ["-e", script]);
    currentAskChild = child;
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90_000);
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (currentAskChild === child) currentAskChild = null; resolve(v); };
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      finish(code === 0 && out.includes("立即重启"));
      if (!done) return;
    });
    child.on("error", (e) => { log("ask dialog 启动失败:", e.message); finish(false); });
  });
}

async function maybeAskTakeover() {
  if (!config.takeover || failedTakeovers >= (config.maxFailedTakeovers ?? 3)) return dbg("bail: takeover off / failed>=3", failedTakeovers);
  let pids = appPids();
  if (!pids.length) return dbg("bail: no pids");
  if (await cdpUp()) return dbg("bail: cdpUp TRUE");
  const uptimes = appUptimes(pids);
  const uptime = uptimes.length ? Math.min(...uptimes) : 0;
  if (uptime < 4) return dbg("bail: uptime<4", uptime);
  if (Date.now() - lastRelaunchAt < 30_000) return dbg("bail: 30s cooldown", Date.now() - lastRelaunchAt);
  const key = runKey(pids);
  // asked.json 清理：超过 30 天的记录过期（防无限增长）
  const nowTs = Date.now();
  for (const k of Object.keys(askedRuns)) {
    if (nowTs - askedRuns[k] > 30 * 24 * 3600 * 1000) delete askedRuns[k];
  }
  if (askedRuns[key]) return dbg("bail: already asked", key.slice(0, 30));
  if (asking) return dbg("bail: asking in flight");
  asking = true;
  try {
    log(`客户端已运行 ${uptime}s 但无 CDP 端口，询问用户是否重启加载…`);
    const yes = await askRestartDialog();
    askedRuns[key] = Date.now(); askedFileWrite();    // 无论选什么，本次运行不再问
    if (!yes) { log("用户选择暂不重启，本次运行不再询问"); return; }
    // 用户同意：重新采样（弹框 60s 内状态可能已变——pid 复用/用户已自己重启等）
    pids = appPids();
    if (!pids.length) { log("用户同意时客户端已退出，跳过"); return; }
    if (await cdpUp()) { log("用户同意时客户端已带端口，无需重启"); return; }
    log("用户同意重启，结束无端口实例并带端口重开…");
    // Windows：kill 前先解析主进程 exe 路径（kill 后拿不到）
    let exePath = null;
    if (IS_WIN) {
      for (const pid of pids) { exePath = winAppExePath(Number(pid)); if (exePath) break; }
    }
    killApp(pids);
    for (let i = 0; i < 20 && appPids().length; i++) await sleep(500);
    await sleep(1000); // 给系统一点收尾时间
    try {
      if (IS_WIN) {
        if (!exePath) throw new Error("无法解析客户端可执行文件路径");
        const child = spawn(exePath, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: "ignore" });
        child.unref();
      } else {
        execFileSync("open", ["-a", APP_NAME, "--args", `--remote-debugging-port=${CDP_PORT}`]);
      }
    } catch (e) { log("relaunch failed:", e.message); return; }
    lastRelaunchAt = Date.now();
    try { atomicWrite(MARKER, String(lastRelaunchAt)); } catch {}
    setTimeout(async () => {
      if (await cdpUp()) { failedTakeovers = 0; log("takeover 成功，CDP 就绪"); }
      else { failedTakeovers++; log(`takeover 后 CDP 未就绪（第 ${failedTakeovers} 次失败）`); }
    }, 60_000);
  } finally { asking = false; }
}
/* 结束客户端进程组：Windows 用 taskkill /T（含子进程），macOS 直接 SIGKILL */
function killApp(pids) {
  if (IS_WIN) {
    for (const pid of pids) {
      try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch {}
    }
    return;
  }
  for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
}

/* ---------- CDP 注入 ---------- */
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP ${res.status}`);
  return res.json();
}
function cdpCall(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    // 必须有超时：页面卡死/连接僵死时否则永远挂起，listener 泄漏且通道瘫痪
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`${method}: timeout`));
    }, 10000);
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
let injectSourceCache = null;
let injectSourceMtime = 0;
async function injectSource() {
  // 按文件 mtime 失效缓存：inject.js 更新后无需重启 daemon 即可生效
  const stat = await statFile(INJECT_PATH);
  if (stat && stat.mtimeMs !== injectSourceMtime) {
    injectSourceCache = await readFile(INJECT_PATH, "utf8");
    injectSourceMtime = stat.mtimeMs;
    log("inject.js (re)loaded, mtime =", injectSourceMtime);
    // 已注入的页面不会自动更新（存活检查会跳过）——主动刷新所有已连接目标
    for (const [url, ws] of targetSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        cdpCall(ws, ++cdpSeq, "Page.reload", {}).catch(() => {});
      }
    }
  }
  return injectSourceCache ?? "";
}
/* 每个页面目标维持一条持久 CDP 连接；按 window.__qwEdit 存活性判断是否需要注入，
 * 页面 reload/导航后自动重注入（连接断开则重建） */
const targetSockets = new Map(); // webSocketDebuggerUrl -> WebSocket
function dropSocket(url) {
  const ws = targetSockets.get(url);
  if (ws) { try { ws.close(); } catch {} targetSockets.delete(url); }
}
async function targetSocket(t) {
  let ws = targetSockets.get(t.webSocketDebuggerUrl);
  if (ws && (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) { dropSocket(t.webSocketDebuggerUrl); ws = undefined; }
  if (ws) return ws;
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("ws open failed")));
  });
  ws.addEventListener("close", () => dropSocket(t.webSocketDebuggerUrl));
  targetSockets.set(t.webSocketDebuggerUrl, ws);
  return ws;
}
let cdpSeq = 100;
async function injectIntoTarget(t) {
  let ws;
  try { ws = await targetSocket(t); } catch (e) { log("connect failed:", e.message); return; }
  try {
    // 先做 mtime 检查（内部会在文件变化时主动 reload 已连接页面）
    await injectSource();
    // 存活检查：页面里已有 __qwEdit 则跳过（reload 后会消失，触发重注入）
    const alive = await cdpCall(ws, ++cdpSeq, "Runtime.evaluate", { expression: "!!window.__qwEdit" });
    if (alive?.result?.value === true) return;
    await cdpCall(ws, ++cdpSeq, "Page.enable");
    await cdpCall(ws, ++cdpSeq, "Page.addScriptToEvaluateOnNewDocument", { source: await injectSource() });
    await cdpCall(ws, ++cdpSeq, "Runtime.evaluate", { expression: await injectSource() });
    log("injected ->", t.title || t.url);
  } catch (e) {
    log("inject failed:", e.message, "— 重连重试");
    dropSocket(t.webSocketDebuggerUrl);
  }
}

/* ---------- daemon 操作通道（遮蔽方案：只读原文件 / 新增遮蔽文件） ----------
 * inject.js 通过 window.__qwEditTakePendingOp / __qwEditResolveOp
 * 与 daemon 通信（经 CDP 轮询，无 HTTP 端口、无 CSP 问题）。
 * 原则：绝不修改/删除任何既有文件；shadow 操作只新增一个截断视图文件。 */
/* 跨平台会话转录根目录候选：
 * macOS: ~/.qwenworkcn/projects、~/.qoderwork/projects
 * Windows: %APPDATA%/QwenWorkCN/{data/,}projects、%LOCALAPPDATA%/QwenWorkCN/{data/,}projects 等
 * 可用 config.json 的 sessionRoots 显式覆盖（数组，优先） */
function sessionRoots() {
  const cfg = Array.isArray(config.sessionRoots) ? config.sessionRoots : [];
  const defaults = IS_WIN ? [
    path.join(process.env.APPDATA || homedir(), "QwenWorkCN", "data", "projects"),
    path.join(process.env.APPDATA || homedir(), "QwenWorkCN", "projects"),
    path.join(process.env.LOCALAPPDATA || homedir(), "QwenWorkCN", "data", "projects"),
    path.join(process.env.LOCALAPPDATA || homedir(), "QwenWorkCN", "projects"),
    path.join(homedir(), ".qwenworkcn", "projects"),
    path.join(homedir(), ".qoderwork", "projects"),
  ] : [
    path.join(homedir(), ".qwenworkcn", "projects"),
    path.join(homedir(), ".qoderwork", "projects"),
  ];
  return [...new Set([...cfg, ...defaults])];
}
async function findSessionFile(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return null; // 防路径注入
  for (const root of sessionRoots()) {
    let dirs;
    try { dirs = await readdir(root); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      try { await statFile(f); return f; } catch {}
    }
  }
  return null;
}
/* 与客户端 normalizeForkPointText 相同的规范化（工作区路径脱敏 + 空白归一）。
 * 同时处理 POSIX（macOS）与 Windows 盘符路径两种形态。 */
function normForkText(s) {
  return (s || "")
    .replace(/(?:file:\/\/)?\/[^\s)\]]*\/(?:\.qoderwork|\.qwenworkcn(?:dev)?)\/workspace\/[^\s)\]]+/g, "<workspace-file>")
    .replace(/(?:[A-Za-z]:[\\/])?[^\s)\]]*[\\/](?:\.qoderwork|\.qwenworkcn(?:dev)?)[\\/]workspace[\\/][^\s)\]]+/gi, "<workspace-file>")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * 遮蔽截断：读原转录 → 定位锚点行（uuid 优先，规范化文本兜底）
 * → 写 <newSessionId>.jsonl（锚点行及之前，行内 sessionId 替换）→ 验证。
 * 原文件不动（审计轨迹）。任何失败：不产生重指后果，遮蔽文件留作惰性孤儿（无害）。
 */
async function shadowTruncate({ sessionId, newSessionId, anchorOrdinal, anchorText, forbidden = [] }) {
  if (!/^[\w-]+$/.test(sessionId || "") || !/^[\w-]+$/.test(newSessionId || "")) {
    return { ok: false, error: "bad-session-id" };
  }
  const srcFile = await findSessionFile(sessionId);
  if (!srcFile) return { ok: false, error: "session-file-not-found" };
  const lines = (await readFile(srcFile, "utf8")).split("\n").filter(Boolean);
  /* 定位锚点行。投影 metadata 的 sdkMessageUuid 与转录行 uuid 是两套 ID（无对应关系），
   * 官方 fork 的文本兜底在多轮同文回答时会错位。但投影与转录是同一事件流的两个
   * append-only 视图，顺序天然对齐：投影第 anchorOrdinal 条助手消息
   * = 转录第 anchorOrdinal 组 assistant 行（按 message.id 分组，跳过 sidechain）。
   * 截断点 = 该组末行。文本做软校验，不一致即中止（宁停不错）。 */
  const groups = []; // { id, end, text }
  let cur = null;
  lines.forEach((l, i) => {
    let obj; try { obj = JSON.parse(l); } catch { return; }
    if (obj?.type !== "assistant" || obj.isSidechain === true) { cur = null; return; }
    const id = obj?.message?.id ?? null;
    const c = obj?.message?.content;
    const texts = Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text) : [];
    if (cur && id !== null && cur.id === id) { cur.end = i; cur.text += texts.join(""); }
    else { cur = { id, end: i, text: texts.join("") }; groups.push(cur); }
  });
  const ordinal = Number(anchorOrdinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > groups.length) {
    return { ok: false, error: `anchor-ordinal-out-of-range (ordinal=${ordinal}, groups=${groups.length})` };
  }
  const g = groups[ordinal - 1];
  // 软校验：锚点组文本应与投影锚点文本一致（允许一方为空或互含）
  if (anchorText) {
    const a = normForkText(anchorText), b = normForkText(g.text);
    if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
      return { ok: false, error: "anchor-text-mismatch", projectionText: a.slice(0, 40), transcriptText: b.slice(0, 40) };
    }
  }
  const idx = g.end;
  const out = lines.slice(0, idx + 1).map((l) => l.split(sessionId).join(newSessionId));
  const dest = path.join(path.dirname(srcFile), `${newSessionId}.jsonl`);
  try { await statFile(dest); return { ok: false, error: "dest-exists" }; } catch {}
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dest, out.join("\n") + "\n", { mode: 0o644 });
  // 验证：被撤回文本必须不在遮蔽文件里
  const newContent = out.join("\n");
  const violations = [];
  for (const t of forbidden) {
    const chunk = (t || "").replace(/\s+/g, " ").replace(/["\\]/g, "").trim().slice(0, 30);
    if (chunk && newContent.includes(chunk)) violations.push(chunk.slice(0, 12) + "…");
  }
  if (violations.length) return { ok: false, error: "forbidden-text-present", violations };
  return { ok: true, file: dest, lines: out.length, originalLines: lines.length };
}
/* 每秒轮询各已连接页面：有待处理操作则执行并回填结果 */
const OP_POLL_MS = 1000;
async function pollOps() {
  for (const [url, ws] of targetSockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      const r = await cdpCall(ws, ++cdpSeq, "Runtime.evaluate", {
        expression: "window.__qwEditTakePendingOp ? window.__qwEditTakePendingOp() : null",
        returnByValue: true,
      });
      const req = r?.result?.value;
      if (!req?.kind) continue;
      const result = req.kind === "shadow" ? await shadowTruncate(req) : { ok: false, error: "unknown-op" };
      result.id = req.id;
      log("op", req.kind, "->", result.ok ? `ok (${result.lines}/${result.originalLines} lines)` : result.error);
      await cdpCall(ws, ++cdpSeq, "Runtime.evaluate", {
        expression: `window.__qwEditResolveOp && window.__qwEditResolveOp(${JSON.stringify(result)})`,
      });
    } catch (e) {
      // 调用超时说明该连接已僵死 → 弃线，下轮主循环重建
      if (/timeout/.test(String(e.message))) dropSocket(url);
    }
  }
}

/* ---------- 主循环：生命周期跟随客户端 ---------- */
async function main() {
  try { mkdirSync(path.join(homedir(), ".qw-edit"), { recursive: true }); } catch {}
  // 单实例锁：已有一个活着的 daemon 时本实例立即退出（防叠框、防重复接管）
  if (!acquireLock()) { log("已有 daemon 实例在运行，本实例退出"); process.exit(0); }
  log(`qw-edit daemon started (takeover=${config.takeover}, platform=${process.platform})`);
  // 初始检查：客户端没跑就立即退出（调度器节流拉起，常态零占用）
  if (!appPids().length && !(await cdpUp())) {
    log("app 未运行，退出（等调度器下轮检查）");
    process.exit(0);
  }
  let cdpDownSince = 0;
  setInterval(pollOps, OP_POLL_MS);
  setInterval(async () => {
    try {
      const up = await cdpUp();
      const pidsNow = appPids();
      dbg("tick up=", up, "pids=", pidsNow.length, pidsNow.join(",") || "(空)");
      if (up) {
        cdpDownSince = 0;
        for (const t of await listTargets()) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          injectIntoTarget(t).catch(() => {});
        }
      } else {
        // CDP 没起来：要么 app 没跑，要么需要询问重启，要么正处重启间隙
        if (pidsNow.length) {
          await maybeAskTakeover();
          cdpDownSince = 0; // app 还在，继续守
        } else if (cdpDownSince === 0) {
          cdpDownSince = Date.now();
        } else if (Date.now() - cdpDownSince > EXIT_GRACE_MS) {
          log("app 已退出，daemon 随之退出");
          process.exit(0);
        }
      }
    } catch (e) { log("loop error:", e?.stack?.split("\n").slice(0, 3).join(" | ") || String(e)); }
  }, POLL_MS);
}
main();