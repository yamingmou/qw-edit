#!/usr/bin/env node
/**
 * qw-edit CLI —— 安装 / 卸载 / 状态管理
 *
 * 用法：
 *   node bin/qw-edit.js install     安装并启动（launchd 常驻，随登录自启）
 *   node bin/qw-edit.js uninstall   卸载
 *   node bin/qw-edit.js status      查看状态
 *   node bin/qw-edit.js enable|disable   开关 takeover（无端口启动时自动带端口重启）
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEST = path.join(homedir(), ".qw-edit");
const LABEL = "com.qwedit.daemon";
const UID = process.getuid();
const PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const CDP_PORT = 9222;

function sh(cmd, args, { okFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
  } catch (e) {
    if (okFail) return "";
    throw e;
  }
}
function readConfig() {
  try { return JSON.parse(readFileSync(path.join(DEST, "config.json"), "utf8")); }
  catch { return { takeover: true }; }
}
function writeConfig(cfg) {
  mkdirSync(DEST, { recursive: true });
  writeFileSync(path.join(DEST, "config.json"), JSON.stringify(cfg, null, 2));
}
function agentState() {
  const out = sh("launchctl", ["print", `gui/${UID}/${LABEL}`], { okFail: true });
  const pid = /pid = (\d+)/.exec(out)?.[1];
  return { loaded: /state =/.test(out), pid };
}
async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
function appRunning() {
  try { return sh("pgrep", ["-x", "QwenWorkCN"], { okFail: true }).trim().length > 0; }
  catch { return false; }
}

function install() {
  mkdirSync(path.join(DEST), { recursive: true });
  cpSync(path.join(ROOT, "src"), path.join(DEST, "src"), { recursive: true });
  if (!existsSync(path.join(DEST, "config.json"))) writeConfig({ takeover: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${DEST}/src/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${DEST}/daemon.log</string>
  <key>StandardErrorPath</key><string>${DEST}/daemon.log</string>
</dict></plist>`;
  mkdirSync(path.dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);

  // （重）加载 agent
  sh("launchctl", ["bootout", `gui/${UID}/${LABEL}`], { okFail: true });
  sh("launchctl", ["bootstrap", `gui/${UID}`, PLIST]);
  sh("launchctl", ["kickstart", `gui/${UID}/${LABEL}`], { okFail: true });

  console.log("✓ qw-edit 已安装并启动");
  console.log(`  生命周期跟随客户端：客户端运行时守护并注入，客户端退出后自动退出`);
  console.log(`  （launchd 每 10s 检查一次，机器上无常驻进程）`);
  console.log(`  安装目录: ${DEST}`);
  console.log(`  日志:     ${DEST}/daemon.log`);
  console.log("");
  console.log("  客户端当前若未带调试端口运行，守护进程会自动带端口重启一次。");
}

function uninstall() {
  sh("launchctl", ["bootout", `gui/${UID}/${LABEL}`], { okFail: true });
  if (existsSync(PLIST)) {
    // 不直接删除，归档到安装目录
    try { renameSync(PLIST, path.join(DEST, "uninstalled.plist")); } catch {}
  }
  console.log("✓ 已卸载 LaunchAgent（~/.qw-edit 目录保留，确认无需后可手动删除）");
}

async function status() {
  const { loaded, pid } = agentState();
  const cfg = readConfig();
  console.log(`LaunchAgent: ${loaded ? `运行中 (pid ${pid ?? "?"})` : "未加载"}`);
  console.log(`takeover:    ${cfg.takeover ? "开启" : "关闭"}（无端口启动时自动带端口重启）`);
  console.log(`千问办公:    ${appRunning() ? "运行中" : "未运行"}`);
  console.log(`CDP :${CDP_PORT}:    ${(await cdpUp()) ? "已就绪（注入生效）" : "未就绪"}`);
}

function setTakeover(on) {
  const cfg = readConfig();
  cfg.takeover = on;
  writeConfig(cfg);
  sh("launchctl", ["kickstart", "-k", `gui/${UID}/${LABEL}`], { okFail: true }); // 重启 daemon 使配置生效
  console.log(`✓ takeover 已${on ? "开启" : "关闭"}（守护进程已重启）`);
}

function usage() {
  console.log(`qw-edit — 千问办公「编辑已发消息」增强

用法:
  qw-edit install    安装并启动（launchd 常驻）
  qw-edit uninstall  卸载
  qw-edit status     查看状态
  qw-edit enable     开启 takeover（默认）
  qw-edit disable    关闭 takeover
  qw-edit --help     显示本帮助

说明:
  安装目录 ~/.qw-edit    日志 ~/.qw-edit/daemon.log    调试端口 127.0.0.1:9222`);
}

const cmd = process.argv[2];
switch (cmd) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": await status(); break;
  case "enable": setTakeover(true); break;
  case "disable": setTakeover(false); break;
  // 约定：无参数与 --help/-h/help 都算"打印用法"，退出码 0；未知子命令才是错误（退出码 1）
  case undefined: case "--help": case "-h": case "help": usage(); break;
  default:
    usage();
    console.error(`\n未知子命令：${cmd}`);
    process.exit(1);
}
