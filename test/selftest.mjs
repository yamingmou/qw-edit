#!/usr/bin/env node
/**
 * qw-edit — 发布前自检（**不依赖千问办公客户端**）
 *
 * 用法：
 *   node test/selftest.mjs              # 开发自检：结构/语法/发布面/纯逻辑；TODO 占位只告警
 *   node test/selftest.mjs --release    # 发布闸门：TODO 占位必须清零、仓库字段必须真实
 *
 * 设计约束（为什么是这些用例）：
 *   · 不启动客户端、不访问 9222 调试端口、不触碰 launchd —— 自检必须能在任何机器上跑；
 *   · `src/daemon.js` **模块顶层即 `main()`**，`src/inject.js` 是浏览器 IIFE
 *     ⇒ 二者**不可 import**（import 会真的起守护进程/在 node 里跑浏览器代码）。
 *     所以对它们只做 `node --check` 语法闸 + 从源码**抽取纯函数**做行为验证。
 *   · 每条"正向"断言都配"阴性对照"：喂坏输入必须非 0 / 必须报错，否则自检可能是空转。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE = process.argv.includes("--release");
const BIN = path.join(ROOT, "bin", "qw-edit.js");
const SRC_FILES = ["src/daemon.js", "src/inject.js"];

let pass = 0, fail = 0, warn = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, detail) => { fail++; console.log(`  ❌ ${name}\n       ${detail}`); };
const warnOnly = (name, detail) => { warn++; console.log(`  ⚠️  ${name}\n       ${detail}`); };

function node(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", ...opts });
}
function npm(args) {
  // Windows 下 npm 是 npm.cmd 批处理，必须 shell:true 才能 spawn；macOS/Linux 直接 spawn
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
}

console.log(`qw-edit selftest${RELEASE ? " [RELEASE GATE]" : ""} — root=${ROOT}\n`);

/* ───────────────────────── 1. CLI 冒烟（正向 + 阴性对照） ───────────────────────── */
console.log("1. CLI");
{
  const r = node([BIN]);                       // 无参数 = 打印用法
  if (r.status === 0 && /用法/.test(r.stdout)) ok("无参数 → exit 0 且打印用法");
  else bad("无参数 → exit 0 且打印用法", `status=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 80))}`);

  const neg = node([BIN, "definitely-not-a-command"]);   // 阴性对照 #1
  if (neg.status !== 0) ok(`阴性对照：未知子命令 → 非 0（exit ${neg.status}）`);
  else bad("阴性对照：未知子命令 → 非 0", "未知子命令竟然 exit 0（错误参数未被拒绝）");

  const help = node([BIN, "--help"]);
  if (help.status === 0 && /用法/.test(help.stdout)) ok("--help → exit 0 且打印用法");
  else if (!RELEASE) warnOnly("--help → exit 0", `当前 exit=${help.status}（约定：--help 应 exit 0）`);
  else bad("--help → exit 0", `当前 exit=${help.status}`);

  // 自检**绝不允许**触碰系统：断言本文件没有真的去执行会改系统的子命令。
  // （只查"真的调用形态"，不查词表本身——否则会咬到自己。）
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const mutating = ["install", "uninstall", "enable", "disable"].filter(
    (s) => self.includes(`BIN, "${s}"`) || self.includes(`BIN, '${s}'`)
  );
  if (mutating.length === 0) ok("自检自身不执行 install/uninstall/enable/disable");
  else bad("自检自身不得执行改系统的子命令", `发现调用：${mutating.join(", ")}`);
}

/* ───────────────────────── 2. 语法闸（正向 + 阴性对照） ───────────────────────── */
console.log("\n2. 语法（node --check）");
{
  const targets = ["bin/qw-edit.js", ...SRC_FILES];
  let allOk = true;
  for (const t of targets) {
    const r = node(["--check", path.join(ROOT, t)]);
    if (r.status !== 0) { allOk = false; bad(`语法 ${t}`, (r.stderr || "").split("\n")[0]); }
  }
  if (allOk) ok(`语法通过：${targets.join(", ")}`);

  // 阴性对照 #2：缺文件必须报错（否则说明语法闸是空转）
  const missing = path.join(ROOT, "src", "__does_not_exist__.js");
  const rm = node(["--check", missing]);
  if (rm.status !== 0 && /Cannot find module|ENOENT|Error/.test(rm.stderr || "")) {
    ok(`阴性对照：缺文件 node --check → 非 0（exit ${rm.status}）`);
  } else {
    bad("阴性对照：缺文件必须报错", `status=${rm.status} stderr=${JSON.stringify((rm.stderr || "").slice(0, 80))}`);
  }

  // 阴性对照 #3：语法坏文件必须被拦
  const dir = mkdtempSync(path.join(tmpdir(), "qw-edit-selftest-"));
  try {
    const broken = path.join(dir, "broken.js");
    // 注意：不能拿 `export function ( {` 之类当坏样本 —— Node 24 的 `--check` 对
    // "疑似 ESM"的文件会走模块语法检测，实测这种样本**退出 0**（假通过）。
    // 这里用无条件语法错误（`const = ;`），Node 任一版本都必红。
    writeFileSync(broken, "const = ;\n");
    const rb = node(["--check", broken]);
    if (rb.status !== 0) ok(`阴性对照：语法坏文件 → 非 0（exit ${rb.status}）`);
    else bad("阴性对照：语法坏文件必须报错", "坏文件通过了 node --check");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ───────────────────────── 3. 纯逻辑：抽取 src/daemon.js 的真实函数 ───────────────────────── */
console.log("\n3. 纯逻辑（从源码抽取 normForkText，测的是**随包发布的那份实现**）");
{
  const src = readFileSync(path.join(ROOT, "src/daemon.js"), "utf8");
  const m = src.match(/function normForkText\(s\) \{[\s\S]*?\n\}/);
  if (!m) {
    bad("抽取 normForkText", "在 src/daemon.js 里找不到该函数（可能被重命名 → 本用例需同步更新）");
  } else {
    // 该函数无自由变量（只用 s + 正则 + 字符串方法），可安全 eval
    let normForkText;
    try { normForkText = new Function(`return (${m[0]})`)(); }
    catch (e) { bad("求值 normForkText", String(e)); }
    if (normForkText) {
      const ws = "/Users/x/Library/Application Support/QwenWorkCN/.qwenworkcn/workspace/abc123/foo.md";
      const out = normForkText(`see ${ws}  \n  ok`);
      if (out.includes("<workspace-file>") && !out.includes("abc123") && out === out.replace(/\s{2,}/g, " ").trim()) {
        ok(`工作区路径被脱敏 + 空白归一 → ${JSON.stringify(out)}`);
      } else {
        bad("工作区路径脱敏 + 空白归一", `got=${JSON.stringify(out)}`);
      }
      // 阴性对照 #4：无关路径**不得**被误伤（否则脱敏过宽，会把真信息吃掉）
      const other = "/tmp/notes/readme.md";
      const out2 = normForkText(other);
      if (out2 === other) ok(`阴性对照：非工作区路径原样保留 → ${JSON.stringify(out2)}`);
      else bad("阴性对照：非工作区路径不得被改写", `got=${JSON.stringify(out2)}`);
      // 边界：空输入不炸
      if (normForkText(undefined) === "" && normForkText("") === "") ok("边界：undefined / 空串 → 空串（不抛）");
      else bad("边界：空输入应返回空串", `undefined→${JSON.stringify(normForkText(undefined))}`);
    }
  }
}

/* ───────────────────────── 4. 发布面（npm pack 实物清点 + 守卫的阴性对照） ───────────────────────── */
console.log("\n4. 发布面（npm pack --dry-run 实物）");
const ALLOWED_EXACT = new Set(["package.json", "README.md", "LICENSE", "bin/qw-edit.js", "src/daemon.js", "src/inject.js"]);
const FORBIDDEN_PREFIX = [".unpack/", "tools/", "test/", "node_modules/", "src/../.unpack"];
/** 返回问题列表（空 = 通过）。抽成函数是为了能用合成坏清单做阴性对照。 */
function classifyPublishSet(files) {
  const problems = [];
  for (const f of files) {
    if (f.split("/").some((seg) => seg === ".unpack")) problems.push(`含 .unpack：${f}`);
    else if (FORBIDDEN_PREFIX.some((p) => f.startsWith(p))) problems.push(`不该发布：${f}`);
    else if (!ALLOWED_EXACT.has(f)) problems.push(`不在白名单：${f}`);
  }
  for (const need of ALLOWED_EXACT) if (!files.includes(need)) problems.push(`缺少必需文件：${need}`);
  return problems;
}
{
  const r = npm(["pack", "--dry-run", "--json"]);
  let files = null;
  try {
    const s = r.stdout || "";
    files = JSON.parse(s.slice(s.indexOf("[")))[0].files.map((x) => x.path);
  } catch { /* 下面统一报错 */ }
  if (!files) {
    bad("读取 npm pack --dry-run --json", `无法解析输出（status=${r.status}）`);
  } else {
    const problems = classifyPublishSet(files);
    if (problems.length === 0) ok(`发布面恰好 ${files.length} 个文件，且 0 个 .unpack/tools：${files.sort().join(", ")}`);
    else bad("发布面白名单", problems.join(" | "));
    const unpackCount = files.filter((f) => f.includes(".unpack")).length;
    if (unpackCount === 0) ok("0 个 .unpack 文件进入发布面");
    else bad("0 个 .unpack 文件", `发现 ${unpackCount} 个`);

    // 阴性对照 #5：守卫必须能拦住合成的坏清单（否则白名单是空转）
    const evil = [...files, ".unpack/renderer/index.html", "tools/test-e2e-regen.cjs"];
    const evilProblems = classifyPublishSet(evil);
    if (evilProblems.length >= 2) ok(`阴性对照：合成坏清单被拦（${evilProblems.length} 条问题）`);
    else bad("阴性对照：合成坏清单必须被拦", `只报出 ${evilProblems.length} 条`);
  }
}

/* ───────────────────────── 5. 文档安全提示（发布面的一部分） ───────────────────────── */
console.log("\n5. 文档");
{
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const must = [
    [/127\.0\.0\.1|本机其他程序|调试端口/, "调试端口的本机暴露面提示"],
    [/非官方|不是官方|无关联/, "非官方/免责声明"],
    [/git clone|npm (i|install)/, "安装说明（源码 clone 或 npm 皆可）"],
  ];
  for (const [re, label] of must) {
    if (re.test(readme)) ok(`README 含：${label}`);
    else bad(`README 缺少：${label}`, "见 PUBLISH-CHECKLIST.md");
  }
  if (/git clone <repo-url>/.test(readme)) bad("README 仍是 <repo-url> 占位", "应替换为可执行说明或明确 TODO");
  else ok("README 无 <repo-url> 裸占位");
}

/* ───────────────────────── 6. 发布闸门（--release） ───────────────────────── */
console.log("\n6. 发布闸门");
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const todoFields = [];
  for (const k of ["author", "homepage", "bugs", "repository"]) {
    const v = typeof pkg[k] === "string" ? pkg[k] : JSON.stringify(pkg[k] ?? "");
    if (/TODO|your-name|<your-account>|example\.com/.test(v)) todoFields.push(k);
  }
  if (todoFields.length === 0) ok("package.json 无 TODO 占位（author/repository/homepage/bugs 均已填）");
  else if (RELEASE) bad("发布闸门：package.json 仍有 TODO 占位", `待填：${todoFields.join(", ")}`);
  else warnOnly("package.json 仍有 TODO 占位（dev 模式仅告警）", `待填：${todoFields.join(", ")} —— 发布前跑 npm run test:release`);

  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) ok(`version 合法：${pkg.version}`);
  else bad("version 必须是合法 semver", String(pkg.version));

  if (JSON.stringify(pkg.files) === JSON.stringify(["bin", "src"])) ok('files 恰为 ["bin","src"]（tools/ 与 .unpack/ 不进包）');
  else bad('files 必须恰为 ["bin","src"]', JSON.stringify(pkg.files));

  if (pkg.type === "module" && pkg.license === "MIT" && pkg.engines?.node) ok("type=module / license=MIT / engines.node 均在");
  else bad("type/type/license/engines 缺失", JSON.stringify({ type: pkg.type, license: pkg.license, engines: pkg.engines }));

  if (RELEASE) {
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    if (/^\.unpack\/?$/m.test(gitignore)) ok(".gitignore 排除 .unpack/");
    else bad(".gitignore 必须排除 .unpack/", "见 .gitignore");
  } else {
    ok("（.gitignore 检查仅在 --release 下强制）");
  }
}

/* ───────────────────────── 汇总 ───────────────────────── */
console.log(`\n汇总：pass=${pass} fail=${fail} warn=${warn}${RELEASE ? "（RELEASE GATE）" : ""}`);
if (fail > 0) {
  console.log(fail && "结果：失败 —— 不要发布（见上）");
  process.exit(1);
}
console.log("结果：通过" + (warn ? "（有告警，发布前请清零 TODO）" : ""));
