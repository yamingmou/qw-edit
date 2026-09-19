#!/usr/bin/env node
/**
 * qw-edit daemon — CDP 注入守护进程（生命周期跟随客户端）
 *
 * 设计原则：注入脚本之外零动作，不直接读写客户端任何数据。
 *
 * 生命周期（配合 launchd KeepAlive + ThrottleInterval）：
 *  - 客户端未运行 → 立即退出（launchd 每 10s 拉起做一次毫秒级检查，机器上无常驻进程）
 *  - 客户端运行且带调试端口 → 常驻，注入并保持
 *  - 客户端运行但无端口 → takeover：带端口重启一次（config.takeover 可关）
 *  - 客户端退出（CDP 消失）→ 退出，等 launchd 下轮拉起
 */
import { readFile, readdir, stat as statFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const CDP_PORT = 9222;
const POLL_MS = 3000;
const EXIT_GRACE_MS = 15000; // CDP 消失后宽限，防 app 重启间隙误退出
const APP_NAME = "QwenWorkCN"; // macOS 应用进程名（pgrep -x 精确匹配）
const MARKER = path.join(tmpdir(), "qw-edit-relaunch.marker");
const CONFIG_PATH = path.join(homedir(), ".qw-edit", "config.json");
const INJECT_PATH = new URL("./inject.js", import.meta.url);

const config = { takeover: true, maxFailedTakeovers: 3 };
try { Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, "utf8"))); } catch {}

const injected = new Set(); // 已废弃，保留兼容
let lastRelaunchAt = 0;
let failedTakeovers = 0;
if (existsSync(MARKER)) { try { lastRelaunchAt = Number(readFileSync(MARKER, "utf8")) || 0; } catch {} }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[daemon ${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------- 进程探测 ---------- */
function appPids() {
  try {
    return execFileSync("pgrep", ["-x", APP_NAME]).toString().split("\n").filter(Boolean);
  } catch { return []; }
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
async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/* ---------- takeover：无端口运行 → 自动带端口重启 ---------- */
async function maybeTakeover() {
  if (!config.takeover || failedTakeovers >= (config.maxFailedTakeovers ?? 3)) return;
  const pids = appPids();
  if (!pids.length || (await cdpUp())) return;
  const uptime = Math.min(...pids.map(appUptime));
  if (uptime < 4) return;                            // 刚启动，稍等
  if (Date.now() - lastRelaunchAt < 30_000) return;   // 防重启风暴
  log(`客户端已运行 ${uptime}s 但无 CDP 端口，带端口重启…`);
  try { execFileSync("osascript", ["-e", `quit app "${APP_NAME}"`]); } catch {}
  for (let i = 0; i < 30 && appPids().length; i++) await sleep(1000);
  await sleep(2);
  try {
    execFileSync("open", ["-a", APP_NAME, "--args", `--remote-debugging-port=${CDP_PORT}`]);
  } catch (e) { log("relaunch failed:", e.message); return; }
  lastRelaunchAt = Date.now();
  try { writeFileSync(MARKER, String(lastRelaunchAt)); } catch {}
  // 60s 内 CDP 未就绪视为失败，累计防风暴
  setTimeout(async () => {
    if (await cdpUp()) { failedTakeovers = 0; log("takeover 成功，CDP 就绪"); }
    else { failedTakeovers++; log(`takeover 后 CDP 未就绪（第 ${failedTakeovers} 次失败）`); }
  }, 60_000);
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
const SESSION_ROOTS = [
  path.join(homedir(), ".qwenworkcn", "projects"),
  path.join(homedir(), ".qoderwork", "projects"),
];
async function findSessionFile(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return null; // 防路径注入
  for (const root of SESSION_ROOTS) {
    let dirs;
    try { dirs = await readdir(root); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      try { await statFile(f); return f; } catch {}
    }
  }
  return null;
}
/* 与客户端 normalizeForkPointText 相同的规范化（工作区路径脱敏 + 空白归一） */
function normForkText(s) {
  return (s || "")
    .replace(/(?:file:\/\/)?\/[^\s)\]]*\/(?:\.qoderwork|\.qwenworkcn(?:dev)?)\/workspace\/[^\s)\]]+/g, "<workspace-file>")
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
  log(`qw-edit daemon started (takeover=${config.takeover})`);
  // 初始检查：客户端没跑就立即退出（launchd 节流拉起，常态零占用）
  if (!appPids().length && !(await cdpUp())) {
    log("app 未运行，退出（等 launchd 下轮检查）");
    process.exit(0);
  }
  let cdpDownSince = 0;
  setInterval(pollOps, OP_POLL_MS);
  setInterval(async () => {
    try {
      const up = await cdpUp();
      if (up) {
        cdpDownSince = 0;
        for (const t of await listTargets()) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          injectIntoTarget(t).catch(() => {});
        }
      } else {
        // CDP 没起来：要么 app 没跑，要么需要 takeover，要么正处重启间隙
        if (appPids().length) {
          await maybeTakeover();
          cdpDownSince = 0; // app 还在，继续守
        } else if (cdpDownSince === 0) {
          cdpDownSince = Date.now();
        } else if (Date.now() - cdpDownSince > EXIT_GRACE_MS) {
          log("app 已退出，daemon 随之退出");
          process.exit(0);
        }
      }
    } catch { /* 静默重试 */ }
  }, POLL_MS);
}
main();
