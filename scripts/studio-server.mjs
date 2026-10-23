#!/usr/bin/env node
// 剪辑台本地服务 —— 零依赖，只绑 127.0.0.1。
//
//   node scripts/studio-server.mjs            # http://127.0.0.1:5179
//
// 它做的事：上传素材 → 保存 Key → 起 firstcut/run.mjs → 读审核队列 → 收决定 →
// 调 firstcut/reexport.mjs 重剪。真正的剪辑逻辑全在 firstcut/ 里，这里只是壳。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clipReviewItems, applyDecisions } from "../firstcut/review-clip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STUDIO = path.join(ROOT, "studio");
const EPISODES = path.join(ROOT, "episodes");
const UPLOADS = path.join(ROOT, "uploads");
const ENV_PATH = path.join(ROOT, ".env");
const PORT = Number(process.env.STUDIO_PORT || 5179);

const NODE = process.execPath;
const FFMPEG = process.env.XUNJIAN_FFMPEG || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(?=[^/\\]*$)/, "ffprobe");

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(EPISODES, { recursive: true });

// ────────────────────────── .env 读写 ──────────────────────────
function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
function writeEnvKey(key, val) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  let hit = false;
  const out = lines.map((l) => {
    if (/^\s*DASHSCOPE_API_KEY\s*=/.test(l)) { hit = true; return `DASHSCOPE_API_KEY=${val}`; }
    return l;
  });
  if (!hit) out.push(`DASHSCOPE_API_KEY=${val}`);
  fs.writeFileSync(ENV_PATH, out.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n");
}
function writeEnvExportDir(dir) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  let hit = false;
  const norm = dir.replace(/\\/g, "/");
  const out = lines.map((l) => {
    if (/^\s*XUNJIAN_EXPORT_DIR\s*=/.test(l)) { hit = true; return `XUNJIAN_EXPORT_DIR=${norm}`; }
    return l;
  });
  if (!hit) out.push(`XUNJIAN_EXPORT_DIR=${norm}`);
  fs.writeFileSync(ENV_PATH, out.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n");
}
const maskKey = (k) => (!k ? "" : k.length <= 10 ? "••••" : `${k.slice(0, 6)}${"•".repeat(12)}${k.slice(-4)}`);

// 基线计划 + 决定 = 有效片段表（计划本身永远不改，反复重剪才幂等）
function readOverrides(name) {
  const f = path.join(EPISODES, name, "work/overrides.json");
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, "utf8")).decisions || []; } catch { return []; }
}

// 上传时的素材档：让「上传完还没剪」和「刷新页面」都能找回原片，而不是只剩一个空壳任务名
const metaPath = (name) => path.join(EPISODES, name, "work/meta.json");
function readMeta(name) {
  const f = metaPath(name);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function writeMeta(name, data) {
  const f = metaPath(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 1));
}

// ────────────────────────── 小工具 ──────────────────────────
const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});
const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80);

// 子进程环境：百炼走直连。本机代理（http_proxy）会间歇性拒绝连接，而 dashscope 直连正常；
// 用 NO_PROXY 做外科式例外，不影响其它域名（GitHub 等仍需代理）。
const childEnv = () => {
  const no = ["dashscope.aliyuncs.com", "aliyuncs.com", "127.0.0.1", "localhost"];
  const cur = process.env.NO_PROXY || process.env.no_proxy || "";
  const merged = [...new Set([...cur.split(",").map((x) => x.trim()).filter(Boolean), ...no])].join(",");
  return { ...process.env, NO_PROXY: merged, no_proxy: merged };
};

// 直连 GET（不走 env 代理）：用于 Key 连通性测试
function httpsGetDirect(url, headers, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers, agent: false, timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", reject);
    req.end();
  });
}

const run = (cmd, args, opts = {}) => spawn(cmd, args, { cwd: ROOT, windowsHide: true, env: childEnv(), ...opts });

// ────────────────────────── 任务状态 ──────────────────────────
// 单任务串行：本机工具，不做并发队列。
const jobs = new Map();   // name -> { running, logs, stage, pct, done, exitCode, error, startedAt, finished }
const JOB_KEEP = 8;

function newJob(name) {
  const j = {
    name, running: true, done: false, stage: "上传完成", pct: 3,
    logs: [], exitCode: null, error: null, startedAt: Date.now(), finished: 0,
    mode: "cut",
  };
  jobs.set(name, j);
  if (jobs.size > JOB_KEEP) {
    const oldest = [...jobs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest && !oldest[1].running) jobs.delete(oldest[0]);
  }
  return j;
}

const STAGE_RULES = [
  [/探测原片/, "读取素材", 5],
  [/检测气口/, "分析停顿", 10],
  [/转写|ASR|paraformer/i, "语音转写", 22],
  [/重说|卡壳|假起头/, "检测重说", 58],
  [/语气词裁决/, "语气词复核", 66],
  [/语义冗余|裁决/, "语义裁决", 72],
  [/剪切|转码/, "剪辑合成", 84],
  [/响度/, "响度归一", 94],
  [/剪辑层完成|完成/, "完成", 100],
];
function pumpLog(job, chunk) {
  const text = chunk.toString("utf8");
  job.logs.push(text);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const [re, stage, pct] of STAGE_RULES) {
      if (re.test(line) && pct >= job.pct) { job.stage = stage; job.pct = pct; break; }
    }
  }
}

function startCut(name, file) {
  const job = newJob(name);
  // 自动起跑后用户没有「开始剪辑」按钮可点，所以尝试次数与上次错误必须写进 meta：
  // 刷新页面时才知道「这条素材是还没跑过（该自动开始）」还是「跑过了但失败（该给重试）」。
  try {
    const m = readMeta(name) || {};
    writeMeta(name, { ...m, attempts: (m.attempts || 0) + 1, lastRunAt: new Date().toISOString() });
  } catch {}
  const child = run(NODE, ["firstcut/run.mjs", file, "--cut-only", "--name", name]);
  job.child = child;
  child.stdout.on("data", (c) => pumpLog(job, c));
  child.stderr.on("data", (c) => pumpLog(job, c));
  child.on("error", (e) => { job.error = e.message; job.running = false; job.done = true; });
  child.on("close", (code) => {
    job.running = false;
    job.done = true;
    job.exitCode = code;
    job.finished = Date.now();
    job.pct = code === 0 ? 100 : job.pct;
    job.stage = code === 0 ? "待审核" : "失败";
    if (code !== 0) job.error = job.error || "剪辑进程退出码 " + code;
    // 日志落盘：服务重启/页面刷新后「处理日志」还能看到这次跑到了哪一步
    try {
      fs.mkdirSync(path.join(EPISODES, name, "work"), { recursive: true });
      fs.writeFileSync(path.join(EPISODES, name, "work/run.log"), job.logs.join(""));
    } catch {}
    try {
      const m = readMeta(name);
      if (m) writeMeta(name, { ...m, lastExit: code, lastError: code === 0 ? null : (job.error || "退出码 " + code) });
    } catch {}
    try { finalizeExport(name); } catch (e) { job.error = String(e.message || e); }
  });
  return job;
}

// ────────────────────────── 成片版本链 ──────────────────────────
// v1 = 首剪产物，沿用原名 cam-<name>.mp4（下游脚本仍按这个名字读）；v2 起为 cam-<name>.vN.mp4。
// 版本档 work/versions.json 由 run.mjs / reexport.mjs 维护；没有档的老工程按磁盘现推一份，
// 保证任何工程一进来就能回看，而不是"历史从今天开始"。
const epDir = (name) => path.join(EPISODES, name);

function resolveVerFile(name, rel) {
  const ep = path.resolve(epDir(name));
  const p = path.resolve(ep, String(rel || ""));
  if (p !== ep && !p.startsWith(ep + path.sep)) return null;  // 版本档里的路径不许跳出工程目录
  return fs.existsSync(p) ? p : null;
}

function scanVersions(name) {
  const dir = path.join(epDir(name), "hf/assets");
  const items = [];
  if (!fs.existsSync(dir)) return { name, current: 0, items };
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^cam-${esc}(?:\\.v(\\d+))?\\.mp4$`);
  let files = [];
  try { files = fs.readdirSync(dir); } catch { files = []; }
  for (const f of files) {
    const m = re.exec(f);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 1;
    const abs = path.join(dir, f);
    let size = 0, at = null;
    try { const st = fs.statSync(abs); size = st.size; at = st.mtime.toISOString(); } catch {}
    if (size < 1024) continue;   // 0 字节/刚创建的文件不是成片，可能是别的进程正在写
    items.push({ v, file: `hf/assets/${f}`, kind: v === 1 ? "cut" : "reexport", at, dur: null,
      segs: null, size, note: v === 1 ? "首剪" : `第 ${v} 版` });
  }
  items.sort((a, b) => a.v - b.v);
  // 时长要显示给用户做对比，只能问 ffprobe；这一步只在新工程首次访问时发生，
  // 结果立刻落盘成 versions.json，之后都是读文件。
  for (const it of items) {
    const p = path.join(dir, path.basename(it.file));
    try {
      const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
        { encoding: "utf8", windowsHide: true });
      const d = Number(String(r.stdout || "").trim());
      if (Number.isFinite(d) && d > 0) it.dur = +d.toFixed(3);
    } catch {}
  }
  const doc = { name, current: items.length ? items[items.length - 1].v : 0, items };
  // 只在真有版本时落盘：全空时写盘会盖掉一个「文件丢了但历史记录还在」的旧档
  if (items.length) {
    try {
      fs.mkdirSync(path.join(epDir(name), "work"), { recursive: true });
      fs.writeFileSync(path.join(epDir(name), "work/versions.json"), JSON.stringify(doc, null, 1));
    } catch {}
  }
  return doc;
}

function readVersionDoc(name) {
  const f = path.join(epDir(name), "work/versions.json");
  if (fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (Array.isArray(j.items) && j.items.length) {
        // 只保留磁盘上真的还在的版本，避免档里有、文件没了 → 前端点到 404
        const alive = j.items.filter((x) => resolveVerFile(name, x.file)).sort((a, b) => a.v - b.v);
        if (alive.length) return { ...j, items: alive, current: alive[alive.length - 1].v };
      }
    } catch {}
  }
  return scanVersions(name);
}

// 当前版 = 编号最大的可用文件（不是 current 字段：中断/手删都可能让 current 指向空）
function currentVersion(name) {
  const doc = readVersionDoc(name);
  const items = (doc.items || []).slice().sort((a, b) => a.v - b.v);
  if (!items.length) return { v: 0, file: null, item: null, doc };
  const it = items[items.length - 1];
  return { v: it.v, file: resolveVerFile(name, it.file), item: it, doc };
}

function versionFile(name, v) {
  const it = (readVersionDoc(name).items || []).find((x) => Number(x.v) === Number(v));
  return it ? resolveVerFile(name, it.file) : null;
}

function versionList(name) {
  const doc = readVersionDoc(name);
  return (doc.items || []).slice().sort((a, b) => b.v - a.v).map((x) => {
    const abs = resolveVerFile(name, x.file);
    let size = x.size ?? null;
    // 老档没记 size（扫描补记的版本）→ 现场量一次，前端要显示体积
    if (size == null && abs) { try { size = fs.statSync(abs).size; } catch {} }
    return {
      v: x.v, dur: x.dur ?? null, segs: x.segs ?? null, at: x.at || null,
      kind: x.kind || "reexport", note: x.note || "", size,
      cuts: x.cuts ?? null, cutsDur: x.cutsDur ?? null,
      exists: !!abs,
    };
  });
}

// 成片复制到用户指定的导出目录（未指定就用默认 exports/，否则页面承诺的路径是空的）
// 两条落点：<name>.mp4 恒为最新（外部只认这个名字），<name>.vN.mp4 逐版留档。
function finalizeExport(name) {
  const env = readEnv();
  const dir = env.XUNJIAN_EXPORT_DIR || path.join(ROOT, "exports");
  const doc = readVersionDoc(name);
  const cur = currentVersion(name);
  if (!cur.file) return;
  fs.mkdirSync(dir, { recursive: true });
  // 最新版固定占用 <name>.mp4（外部脚本/分享都只认这个名字）
  fs.copyFileSync(cur.file, path.join(dir, `${name}.mp4`));
  // 逐版留档：缺哪个补哪个，已有的不重复拷（单版可能近 100MB）
  for (const it of doc.items || []) {
    const src = resolveVerFile(name, it.file);
    if (!src) continue;
    const snap = path.join(dir, `${name}.v${it.v}.mp4`);
    if (!fs.existsSync(snap)) fs.copyFileSync(src, snap);
  }
}

// 老工程（当年直接跑命令行、没经过剪辑台）没有 run.log。展开日志时按磁盘产物拼一份摘要，
// 比「展开后还是那几行」有用，同时明说这不是原始日志，别让人误以为是完整 stdout。
function readJsonSafe(f) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function digestLog(name) {
  const w = path.join(EPISODES, name, "work");
  const meta = readMeta(name) || {};
  const plan = readJsonSafe(path.join(w, "cut-plan.json"));
  const segsRaw = readJsonSafe(path.join(w, "raw-segs.json"));
  const retake = readJsonSafe(path.join(w, "retake-report.json"));
  const verd = readJsonSafe(path.join(w, "redundancy-verdicts.json"));
  const rq = readJsonSafe(path.join(w, "review-queue.json"));
  const vdoc = readJsonSafe(path.join(w, "versions.json"));
  const dec = readOverrides(name);
  const lines = ["[本工程没有原始日志留档 · 以下按产物重建，仅供回看]", ""];

  const base = meta.base || (plan && plan.input ? path.basename(plan.input) : "");
  if (base) lines.push(`素材      ${base}`);
  const rawDur = meta.dur ?? (plan && plan.rawDur) ?? null;
  if (rawDur) {
    const ori = meta.vertical == null ? "" : meta.vertical ? " · 竖屏" : " · 横屏";
    lines.push(`原片      ${Number(rawDur).toFixed(1)}s${ori}`);
  }
  if (Array.isArray(segsRaw)) lines.push(`转写      ${segsRaw.length} 条语音片段`);
  if (retake && Array.isArray(retake.cuts)) lines.push(`重说      ${retake.cuts.length} 处检出`);
  if (verd && Array.isArray(verd.verdicts)) lines.push(`语义裁决  ${verd.verdicts.length} 条（${verd.model || "模型未记"}）`);
  if (plan && Array.isArray(plan.segs)) {
    const keep = plan.segs.reduce((a, [s, e]) => a + (e - s), 0) / (plan.speed || 1);
    lines.push(`基线计划  ${plan.segs.length} 段保留 · 成片 ${keep.toFixed(1)}s`);
  }
  if (rq && Array.isArray(rq.items)) lines.push(`待确认    ${rq.items.length} 条`);
  if (dec.length) lines.push(`已裁决    ${dec.length} 条`);
  if (vdoc && Array.isArray(vdoc.items) && vdoc.items.length) {
    const last = [...vdoc.items].sort((a, b) => b.v - a.v)[0];
    const dur = last.dur ? ` · ${Number(last.dur).toFixed(1)}s` : "";
    const at = last.at ? ` · ${String(last.at).replace("T", " ").slice(0, 16)}` : "";
    lines.push(`版本      v${last.v}${dur}${at}`);
  }
  return lines.join("\n");
}

// ────────────────────────── 审核代理（720p / 密集关键帧）──────────────────────────
// 浏览器 seek 只能落在关键帧上，原片 GOP 常超 2s → 审核听不出切口前后。代理每 0.5s 一个关键帧。
//
// 关键：ffmpeg 是边转边写的，moov 要到最后一刻才落盘。若直接以正式名输出，转码期间
// /api/video 会返回 200 + 一个没有 moov 的半截文件，浏览器解不了 → 表现为「预览黑屏」。
// 实测 60s/1080p 有这个窗口约 9s，2 分钟素材约半分钟。所以写 .part.mp4，成功后再原子改名。
const MEDIA = new Map(); // key -> { proxy: { ready, running, pct, err } }
function mediaOf(key) {
  if (!MEDIA.has(key)) MEDIA.set(key, { proxy: { ready: false, running: false, pct: 0, err: null } });
  return MEDIA.get(key);
}

function ensureProxy(uploaded, key, dur = 0) {
  const out = path.join(EPISODES, key, "work/proxy.mp4");
  const part = out + ".part.mp4";
  const m = mediaOf(key);
  if (fs.existsSync(out)) { m.proxy = { ready: true, running: false, pct: 100, err: null }; return out; }
  if (m.proxy.running) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try { fs.unlinkSync(part); } catch {}
  m.proxy = { ready: false, running: true, pct: 0, err: null };
  const p = run(FFMPEG, ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i", uploaded,
    "-vf", "scale=-2:720", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast",
    "-g", "15", "-keyint_min", "15", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", part]);
  let buf = "";
  p.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const l of lines) {
      const mm = /^out_time_us=(\d+)/.exec(l.trim());
      if (mm && dur > 0) m.proxy.pct = Math.min(99, Math.round((Number(mm[1]) / 1e6 / dur) * 100));
    }
  });
  p.on("close", (code) => {
    m.proxy.running = false;
    if (code === 0) {
      try { fs.renameSync(part, out); m.proxy.ready = true; m.proxy.pct = 100; }
      catch (e) { m.proxy.err = "预览代理落盘失败：" + String(e.message || e); }
    } else {
      m.proxy.err = "预览代理生成失败（ffmpeg 退出码 " + code + "）";
      try { fs.unlinkSync(part); } catch {}
    }
  });
  return out;
}

// ────────────────────────── 打开文件/目录 ──────────────────────────
// mode: open（默认程序打开）/ select（在资源管理器中选中）/ dir（只开目录）
function openWith(target, mode = "open") {
  let isFile = false;
  try { isFile = fs.statSync(target).isFile(); } catch { return; }
  const opt = { detached: true, stdio: "ignore" };
  if (process.platform === "win32") {
    if (mode === "select" && isFile) {
      // /select,<path> 必须是一个参数，拆成两个 explorer 会当普通路径处理
      spawn("explorer.exe", ["/select," + target], opt).unref();
    } else if (mode === "dir" || !isFile) {
      spawn("explorer.exe", [isFile ? path.dirname(target) : target], opt).unref();
    } else {
      // 媒体文件不是可执行文件，只能借 cmd 的 start 交给默认关联程序
      spawn("cmd", ["/c", "start", "", target], { ...opt, windowsHide: true }).unref();
    }
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", mode === "select" ? ["-R", target] : [target], opt).unref();
    return;
  }
  spawn("xdg-open", [isFile ? path.dirname(target) : target], opt).unref();
}

// ────────────────────────── 选文件夹（系统对话框）──────────────────────────
// 网页没有能力拿到「本地绝对路径」（<input webkitdirectory> 只给相对名，File System
// Access API 只给 handle 不给路径），而导出目录必须是服务端能写的绝对路径。
// 所以由本机服务用 PowerShell 弹一个真正的系统文件夹选择器，把结果写到临时文件里带回来。
// 参数走环境变量传，脚本体是固定字符串（base64 编码），不拼路径 → 不存在注入问题。
// owner 用「屏幕正中 1×1 全透明窗体」：既保证对话框不会被别的窗口盖住（TopMost），
// 又保证它居中出现在可见区域（把 owner 挪到屏幕外会让对话框跟着跑出画面）。
const PICK_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '选择导出文件夹'
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择成片导出文件夹'
$dlg.ShowNewFolderButton = $true
if ($env:PICK_INITIAL -and (Test-Path -LiteralPath $env:PICK_INITIAL)) { $dlg.SelectedPath = $env:PICK_INITIAL }
$r = $dlg.ShowDialog($owner)
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText($env:PICK_OUT, $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))
}
$owner.Close()
$owner.Dispose()
`;

// PowerShell 的错误输出重定向到管道时会变成 CLIXML，直接吐给前端就是一串 XML
function psErr(err) {
  const clean = String(err || "")
    .replace(/^#<\s*CLIXML.*$/gm, "")
    .replace(/<S S="Error">/g, "")
    .replace(/<\/S>/g, "\n")
    .replace(/<\/?Objs[^>]*>/g, "")
    .replace(/_x000D__x000A_/g, "\n");
  const lines = clean.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.pop() || "";
}

function pickFolder(initial) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      return resolve({ ok: false, error: "系统文件夹选择器目前只支持 Windows" });
    }
    const outTxt = path.join(os.tmpdir(), `xunjian-pick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
    let child;
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { fs.unlinkSync(outTxt); } catch {}
      resolve(r);
    };
    try {
      child = spawn("powershell.exe",
        ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(PICK_PS, "utf16le").toString("base64")],
        { windowsHide: true, env: { ...process.env, PICK_INITIAL: String(initial || ""), PICK_OUT: outTxt } });
    } catch (e) { return finish({ ok: false, error: String(e.message || e) }); }

    let err = "";
    // 对话框挂在桌面上等人点，不能让这个请求永远悬着
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, canceled: true, error: "选择超时（5 分钟）" });
    }, 5 * 60 * 1000);
    child.stderr.on("data", (c) => { err = (err + c.toString("utf8")).slice(-2000); });
    child.on("error", (e) => finish({ ok: false, error: String(e.message || e) }));
    child.on("close", () => {
      let dir = "";
      try { dir = fs.readFileSync(outTxt, "utf8").trim(); } catch {}
      if (dir) return finish({ ok: true, dir });
      // 取消选择时 stderr 是空的；非空说明 PowerShell 自己报错了（策略/杀软拦截等）
      const last = psErr(err);
      finish({ ok: false, canceled: !last, error: last });
    });
  });
}

// ────────────────────────── HTTP ──────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4" };

function serveStatic(res, rel) {
  const file = path.join(STUDIO, rel === "/" ? "index.html" : rel.replace(/^\//, ""));
  if (!file.startsWith(STUDIO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; res.end("not found"); return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
}

const VMIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" };

function serveVideo(req, res, file) {
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", VMIME[path.extname(file).toLowerCase()] || "video/mp4");
  // 浏览器拖动进度条会中途 abort 上一段请求；读流出错若不管，未捕获的 error 会直接把服务带崩
  const send = (opts) => {
    const s = fs.createReadStream(file, opts);
    s.on("error", () => { try { res.destroy(); } catch {} });
    res.on("close", () => s.destroy());
    s.pipe(res);
  };
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); res.end(); return; }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    send({ start, end });
  } else {
    res.setHeader("Content-Length", String(size));
    send({});
  }
}

// 首帧封面，按 tag 缓存（tag 里带版本号，所以旧版封面不会被新版串到）
function servePoster(res, name, src, tag) {
  if (!src || !fs.existsSync(src)) { res.statusCode = 404; res.end(); return; }
  const dir = path.join(EPISODES, name, "work");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `poster-${String(tag).replace(/[^\w.-]/g, "_")}.jpg`);
  if (!fs.existsSync(out)) {
    spawnSync(FFMPEG, ["-y", "-v", "error", "-ss", "0.6", "-i", src,
      "-frames:v", "1", "-vf", "scale=-2:720", out], { windowsHide: true });
  }
  if (!fs.existsSync(out)) { res.statusCode = 404; res.end(); return; }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "max-age=300");
  const s = fs.createReadStream(out);
  s.on("error", () => { try { res.destroy(); } catch {} });
  s.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const p = u.pathname;
  try {
    // ── 静态 ──
    if (!p.startsWith("/api/")) return serveStatic(res, p);

    // ── 配置 ──
    if (p === "/api/config" && req.method === "GET") {
      const env = readEnv();
      return json(res, 200, {
        hasKey: !!env.DASHSCOPE_API_KEY,
        masked: maskKey(env.DASHSCOPE_API_KEY),
        model: env.XUNJIAN_LLM_MODEL || "qwen-plus",
        exportDir: env.XUNJIAN_EXPORT_DIR || path.join(ROOT, "exports"),
        asr: env.XUNJIAN_ASR || "paraformer-v2",
      });
    }
    if (p === "/api/config" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (b.apiKey) writeEnvKey("DASHSCOPE_API_KEY", String(b.apiKey).trim());
      let copied = false;
      if (b.exportDir) {
        const dir = String(b.exportDir).trim().replace(/[\\/]+$/, "");
        writeEnvExportDir(dir);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        // 换导出目录时把「当前这一版」顺手复制过去，否则页面写着新路径、点开是空文件夹
        const nm = b.name ? safeName(b.name) : "";
        if (nm) {
          try {
            const cur = currentVersion(nm);
            if (cur.file && fs.existsSync(cur.file)) {
              await fs.promises.copyFile(cur.file, path.join(dir, `${nm}.mp4`));
              copied = true;
            }
          } catch { copied = false; }
        }
      }
      const env = readEnv();
      return json(res, 200, {
        ok: true, hasKey: !!env.DASHSCOPE_API_KEY, copied,
        masked: maskKey(env.DASHSCOPE_API_KEY),
        exportDir: env.XUNJIAN_EXPORT_DIR || path.join(ROOT, "exports"),
      });
    }
    // 弹系统文件夹选择器（用于「导出地址 → 更改」）
    if (p === "/api/pick-dir" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const r = await pickFolder(b.initial ? String(b.initial) : "");
      return json(res, 200, r);
    }
    if (p === "/api/config/test" && req.method === "POST") {
      const env = readEnv();
      if (!env.DASHSCOPE_API_KEY) return json(res, 200, { ok: false, error: "还没有保存 Key" });
      const t0 = Date.now();
      try {
        const r = await httpsGetDirect("https://dashscope.aliyuncs.com/compatible-mode/v1/models",
          { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` });
        const ms = Date.now() - t0;
        if (r.status === 200) return json(res, 200, { ok: true, ms });
        return json(res, 200, { ok: false, error: `HTTP ${r.status} ${String(r.body || "").slice(0, 120)}`, ms });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    // ── 素材列表（顶部下拉用）──
    // 只列「剪辑台产生」的工程（ui-*）。老工程的 meta.json 可能没有，就退回 cut-plan.json
    // 里的 input/rawDur —— 否则 C0779 这种早期上传的素材不会出现在下拉里。
    if (p === "/api/projects" && req.method === "GET") {
      let dirs = [];
      try {
        dirs = fs.readdirSync(EPISODES, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith("ui-")).map((d) => d.name);
      } catch { dirs = []; }
      const items = [];
      for (const name of dirs) {
        const meta = readMeta(name);
        const cp = path.join(EPISODES, name, "work/cut-plan.json");
        let plan = null;
        try { if (fs.existsSync(cp)) plan = JSON.parse(fs.readFileSync(cp, "utf8")); } catch {}
        const file = meta?.file || plan?.input || null;
        if (!file || !fs.existsSync(file)) continue;            // 素材没了就不列，免得点开全空
        const title = path.basename(meta?.base || file).replace(/\.[^.]+$/, "");
        if (title.startsWith("_")) continue;                     // 探针/冒烟测试的临时素材
        const j = jobs.get(name);
        // 只读版本档，不走 scanVersions（那个要跑 ffprobe，列表接口不能被它拖慢）
        let out = null;
        try {
          const vf = path.join(EPISODES, name, "work/versions.json");
          if (fs.existsSync(vf)) {
            const doc = JSON.parse(fs.readFileSync(vf, "utf8"));
            const last = (doc.items || []).slice().sort((a, b) => b.v - a.v)[0];
            if (last) out = { v: last.v, dur: last.dur ?? null };
          }
        } catch {}
        // 没有版本档的老工程（如 C0793）：用「保留段 − 决定」算出成片时长，别让下拉显示成「已初剪」空档
        if (!out && plan) {
          try {
            const eff = applyDecisions(plan.segs || [], readOverrides(name));
            const d = eff.reduce((a, [s, e]) => a + (e - s), 0) / (plan.speed || 1);
            if (d > 0) out = { v: 0, dur: +d.toFixed(3) };
          } catch {}
        }
        let at = meta?.uploadedAt || null;
        if (!at) { try { at = fs.statSync(file).mtime.toISOString(); } catch {} }
        items.push({
          name, title, file,
          dur: meta?.dur ?? plan?.rawDur ?? null,
          vertical: meta?.vertical ?? null,
          size: meta?.size ?? (() => { try { return fs.statSync(file).size; } catch { return null; } })(),
          at,
          state: j?.running ? "running"
            : plan ? (j?.error ? "failed" : "done")
            : (meta?.lastError ? "failed" : "idle"),
          stage: j?.stage || (plan ? "待审核" : "待处理"),
          pct: j?.pct ?? (plan ? 100 : 0),
          out,
        });
      }
      // 同一个源文件传过两次会生成两个工程目录 —— 下拉是「素材」列表，只保留一条。
      // 选哪条：版本多（历史更全）优先，其次新的；另一条仍可按名字直接访问。
      const byFile = new Map();
      for (const it of items) {
        const k = path.resolve(it.file).toLowerCase();
        const prev = byFile.get(k);
        if (!prev) { byFile.set(k, it); continue; }
        const av = (prev.out && prev.out.v) || 0, bv = (it.out && it.out.v) || 0;
        const newer = String(it.at || "") > String(prev.at || "");
        // 同一路径只出现在「改造前的老工程」（新上传每条素材独占目录，路径不会撞）。
        // 这种历史重复里保留版本多的那条 —— 那才是用户真正改过决定、有记录可回看的工程。
        if (bv > av || (bv === av && newer)) byFile.set(k, it);
      }
      const uniq = [...byFile.values()];
      uniq.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      return json(res, 200, { ok: true, items: uniq });
    }

    // ── 上传 ──
    if (p === "/api/upload" && req.method === "POST") {
      const raw = decodeURIComponent(req.headers["x-filename"] || "");
      if (!raw) return json(res, 400, { ok: false, error: "缺少文件名" });
      const base = safeName(raw);
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
      // 每条素材独占一个目录：同名文件二次上传不能覆盖上一版（下拉里两条素材会指向同一个文件）
      let key = `ui-${path.basename(base).replace(/\.[^.]+$/, "").slice(0, 40)}-${stamp}`;
      for (let n = 2; fs.existsSync(path.join(UPLOADS, key)); n++) key = `ui-${path.basename(base).replace(/\.[^.]+$/, "").slice(0, 40)}-${stamp}-${n}`;
      const dir = path.join(UPLOADS, key);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, base);
      const ws = fs.createWriteStream(file);
      await new Promise((resolve, reject) => {
        req.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        req.on("error", reject);
      });
      // 探测
      const info = await new Promise((resolve) => {
        const c = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries",
          "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", file]);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", () => {
          try {
            const j = JSON.parse(out);
            const st = j.streams?.[0] || {};
            const rot = Math.abs(Number((st.side_data_list || []).find((d) => d.rotation != null)?.rotation || 0));
            const vertical = rot === 90 || rot === 270 ? st.width > st.height : st.height > st.width;
            resolve({ dur: Number(j.format?.duration || 0), w: st.width, h: st.height, vertical });
          } catch { resolve({ dur: 0, w: 0, h: 0, vertical: false }); }
        });
        c.on("error", () => resolve({ dur: 0, w: 0, h: 0, vertical: false }));
      });
      // 预先做代理，审核时才有精准 seek
      const sizeNow = fs.statSync(file).size;
      writeMeta(key, { key, base, file, ...info, size: sizeNow, uploadedAt: new Date().toISOString() });
      ensureProxy(file, key, info.dur);
      return json(res, 200, {
        ok: true, file, base, key, ...info,
        size: sizeNow,
      });
    }

    // ── 起任务 ──
    if (p === "/api/run" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!b.file || !fs.existsSync(b.file)) return json(res, 400, { ok: false, error: "文件不存在" });
      if (!readEnv().DASHSCOPE_API_KEY) return json(res, 400, { ok: false, error: "还没有保存 API Key" });
      const name = safeName(b.name);
      if (!name) return json(res, 400, { ok: false, error: "缺少任务名" });
      const j = startCut(name, b.file);
      return json(res, 200, { ok: true, name, job: { stage: j.stage, pct: j.pct } });
    }

    // ── 状态 ──
    // ── 完整处理日志（「处理日志」展开时拉这份，不是轮询里那几行）──
    if (p === "/api/logs" && req.method === "GET") {
      const name = safeName(u.searchParams.get("name") || "");
      const j = jobs.get(name);
      const lf = path.join(EPISODES, name, "work/run.log");
      let text = j && j.logs.length ? j.logs.join("") : "";
      let disk = "";
      if (fs.existsSync(lf)) { try { disk = fs.readFileSync(lf, "utf8"); } catch {} }
      if (!text) text = disk;
      // 重剪任务的 job.logs 只有重剪这一小段，首剪的完整日志在 run.log 里 → 两段拼起来
      else if (j && j.mode === "reexport" && disk.trim() && disk.trim() !== text.trim()) {
        text = `${disk.replace(/\s+$/, "")}\n\n─── 按决定重剪 ───\n${text.replace(/^\s+/, "")}`;
      }
      // 早期是直接跑命令行、没经过剪辑台的工程不会留 run.log → 按产物拼一份摘要
      if (!text.trim()) text = digestLog(name);
      if (text.length > 600 * 1024) text = `……（只保留最后 600KB，完整日志见 ${path.relative(ROOT, lf)}）\n` + text.slice(-600 * 1024);
      return json(res, 200, {
        ok: true, name, text, running: !!(j && j.running),
        lines: text ? text.split(/\r?\n/).filter((x) => x.trim()).length : 0,
      });
    }

    if (p === "/api/state" && req.method === "GET") {
      const name = u.searchParams.get("name") || "";
      const cp0 = path.join(EPISODES, name, "work/cut-plan.json");
      let j = jobs.get(name);
      // 服务重启后内存里没有任务，但磁盘上有结果 → 造一个"已完成"的状态，页面刷新不丢
      if (!j && name && fs.existsSync(cp0)) {
        j = { name, running: false, done: true, stage: "待审核", pct: 100, exitCode: 0,
          error: null, logs: [], startedAt: Date.now(), finished: Date.now(), mode: "cut" };
        jobs.set(name, j);
      }
      // 上传完还没剪（或刷新了页面）：素材档还在 → 返回 idle 态，前端能恢复预览与「开始剪辑」
      if (!j) {
        const meta = readMeta(name);
        if (meta) {
          const failed = !!meta.lastError;
          return json(res, 200, {
            ok: true, name, running: false, done: false, idle: true,
            stage: failed ? "上次处理失败" : "素材已就绪", pct: 3,
            exitCode: failed ? (meta.lastExit ?? 1) : null,
            error: meta.lastError || null, mode: "cut",
            input: meta.file,
            logs: failed
              ? `上次自动处理失败：${meta.lastError}\n可点「处理日志」右侧的「重试」再跑一次`
              : `素材已上传，正在自动处理\n${meta.base || ""}`,
            attempts: meta.attempts || 0,
            reviewCount: null, outDur: null, output: null, hasOutput: false, elapsed: 0,
            dur: meta.dur ?? null, vertical: meta.vertical ?? null,
          });
        }
        return json(res, 404, { ok: false, error: "没有这个任务" });
      }
      const rq = path.join(EPISODES, name, "work/review-queue.json");
      const cp = path.join(EPISODES, name, "work/cut-plan.json");
      let reviewCount = null, outDur = null, inputFile = null, rawDur = null;
      if (fs.existsSync(cp)) {
        try {
          const pl = JSON.parse(fs.readFileSync(cp, "utf8"));
          const eff = applyDecisions(pl.segs, readOverrides(name));
          outDur = eff.reduce((a, [s, e]) => a + (e - s), 0) / (pl.speed || 1);
          inputFile = pl.input || null;
          rawDur = pl.rawDur || null;
          if (fs.existsSync(rq)) {
            const raw = JSON.parse(fs.readFileSync(rq, "utf8")).items || [];
            reviewCount = clipReviewItems(raw, pl.segs).items.length;
          }
        } catch {}
      } else if (fs.existsSync(rq)) {
        try { reviewCount = (JSON.parse(fs.readFileSync(rq, "utf8")).items || []).length; } catch {}
      }
      const cur = currentVersion(name);
      let logs = j.logs.slice(-8).join("");
      if (!logs) {
        // 服务重启后内存日志为空 → 先从 run.log 兜底
        const lf = path.join(EPISODES, name, "work/run.log");
        if (fs.existsSync(lf)) {
          try { logs = fs.readFileSync(lf, "utf8").slice(-3000); } catch {}
        }
      }
      if (!logs && outDur) {
        // 再兜底：给一段真实的结果摘要，而不是让面板空着
        logs = `原片 ${rawDur ? rawDur.toFixed(1) : "?"}s → 成片 ${outDur.toFixed(1)}s（按当前决定）\n`
          + `待你确认 ${reviewCount ?? 0} 条\n`
          + `成片 ${cur.file ? path.relative(ROOT, cur.file) : "（尚未生成）"}`;
      }
      return json(res, 200, {
        ok: true, name, running: j.running, done: j.done, stage: j.stage, pct: j.pct,
        exitCode: j.exitCode, error: j.error, mode: j.mode, input: inputFile,
        logs, reviewCount, outDur,
        output: cur.file, hasOutput: !!cur.file,
        curVer: cur.v, verDur: cur.item ? cur.item.dur ?? null : null,
        versions: versionList(name),
        elapsed: Math.round(((j.finished || Date.now()) - j.startedAt) / 1000),
      });
    }

    // ── 可播放源就绪状态（前端据此决定先挂原片还是等代理）──
    if (p === "/api/media" && req.method === "GET") {
      const name = safeName(u.searchParams.get("name") || "");
      const meta = readMeta(name);
      const m = mediaOf(name);
      const rawFile = meta && meta.file && fs.existsSync(meta.file) ? meta.file : null;
      const proxyFile = path.join(EPISODES, name, "work/proxy.mp4");
      const proxyReady = fs.existsSync(proxyFile);
      // 服务中途重启会把转码进程带走（内存状态清零）。这里惰性续上，否则前端会对着 0% 干等
      if (!proxyReady && !m.proxy.running && !m.proxy.err && rawFile) ensureProxy(rawFile, name, meta.dur || 0);
      const cur = currentVersion(name);
      return json(res, 200, {
        ok: true, name,
        proxy: {
          ready: proxyReady, running: !!m.proxy.running,
          pct: proxyReady ? 100 : (m.proxy.pct || 0), err: m.proxy.err || null,
        },
        raw: { ready: !!rawFile },
        out: { ready: !!cur.file, v: cur.v, versions: versionList(name).length },
        dur: meta?.dur ?? null, vertical: meta?.vertical ?? null,
      });
    }

    // ── 剪辑计划（时间轴用）──
    if (p === "/api/timeline" && req.method === "GET") {
      const name = safeName(u.searchParams.get("name") || "");
      const cp = path.join(EPISODES, name, "work/cut-plan.json");
      const rq = path.join(EPISODES, name, "work/review-queue.json");
      if (!fs.existsSync(cp)) return json(res, 404, { ok: false, error: "还没有剪切计划" });
      const plan = JSON.parse(fs.readFileSync(cp, "utf8"));
      const raw = fs.existsSync(rq) ? JSON.parse(fs.readFileSync(rq, "utf8")).items : [];
      const decisions = readOverrides(name);
      // 防御性再裁一次（老产物 / 队列文件与计划不同步时，避免出现"点了没反应"的假按钮）
      const review = clipReviewItems(raw, plan.segs).items;
      // 时间轴与时长展示的是「按当前决定重剪后」的样子
      const eff = applyDecisions(plan.segs, decisions);
      const gaps = [];
      let cur = 0;
      for (const [s, e] of eff) {
        if (s - cur > 0.05) gaps.push([+cur.toFixed(2), +s.toFixed(2)]);
        cur = e;
      }
      if (plan.rawDur - cur > 0.05) gaps.push([+cur.toFixed(2), +plan.rawDur.toFixed(2)]);
      const cv = currentVersion(name);
      return json(res, 200, {
        ok: true, name, rawDur: plan.rawDur, speed: plan.speed || 1,
        segs: eff, baseSegs: plan.segs, gaps, review, decisions,
        // 「按当前决定应得的时长」与「磁盘上实际那一版」是两件事，别混用
        outDur: eff.reduce((a, [s, e]) => a + (e - s), 0) / (plan.speed || 1),
        curVer: cv.v, verDur: cv.item ? cv.item.dur ?? null : null, versions: versionList(name),
      });
    }

    // ── 决定 ──
    if (p === "/api/decisions" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = safeName(b.name);
      const file = path.join(EPISODES, name, "work/overrides.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ name, savedAt: new Date().toISOString(), decisions: b.decisions || [] }, null, 1));
      return json(res, 200, { ok: true, count: (b.decisions || []).length });
    }

    // ── 重导出 ──
    if (p === "/api/reexport" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = safeName(b.name);
      const j = newJob(name);
      j.mode = "reexport";
      j.stage = "按决定重剪";
      j.pct = 40;
      const child = run(NODE, ["firstcut/reexport.mjs", "--name", name]);
      j.child = child;
      child.stdout.on("data", (c) => pumpLog(j, c));
      child.stderr.on("data", (c) => pumpLog(j, c));
      child.on("close", (code) => {
        j.running = false; j.done = true; j.exitCode = code; j.finished = Date.now();
        if (code === 0) {
          j.pct = 100; j.stage = "重剪完成";
          try { finalizeExport(name); } catch (e) { j.error = String(e.message || e); }
        } else { j.stage = "重剪失败"; j.error = "退出码 " + code; }
      });
      return json(res, 200, { ok: true, name });
    }

    // ── 视频 ──
    if (p === "/api/video" && req.method === "GET") {
      const name = safeName(u.searchParams.get("name") || "");
      const kind = u.searchParams.get("src") || "out";
      if (kind === "out") {
        // 不传 v = 最新版；传 v = 指定的历史版本（A/B 对比靠这个）
        const wantV = Number(u.searchParams.get("v")) || 0;
        const file = wantV > 0 ? versionFile(name, wantV) : currentVersion(name).file;
        return serveVideo(req, res, file);
      }
      // 原片直出：代理还没转完时先给画面，别让用户对着黑框等
      if (kind === "raw") {
        const meta = readMeta(name);
        return serveVideo(req, res, meta && meta.file ? meta.file : null);
      }
      if (kind === "proxy") return serveVideo(req, res, path.join(EPISODES, name, "work/proxy.mp4"));
      return serveVideo(req, res, null);
    }

    // ── 封面（首帧），避免未播放时是黑框 ──
    if (p === "/api/poster" && req.method === "GET") {
      const name = safeName(u.searchParams.get("name") || "");
      const kind = u.searchParams.get("src") || "out";
      if (kind === "out") {
        const wantV = Number(u.searchParams.get("v")) || 0;
        const cur = currentVersion(name);
        const v = wantV > 0 ? wantV : cur.v;
        const src = wantV > 0 ? versionFile(name, wantV) : cur.file;
        return servePoster(res, name, src, `out-v${v}`);
      }
      let src = path.join(EPISODES, name, "work/proxy.mp4");
      if (!fs.existsSync(src)) {
        const meta = readMeta(name);
        src = meta && meta.file ? meta.file : src;
      }
      return servePoster(res, name, src, kind);
    }

    // ── 打开文件夹 / 打开成片 ──
    if (p === "/api/reveal" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = safeName(b.name || "");
      const ep = path.join(EPISODES, name);
      // 和 /api/config 保持同一个默认值，否则页面显示的导出路径根本不存在
      const exportDir = readEnv().XUNJIAN_EXPORT_DIR || path.join(ROOT, "exports");
      const exported = path.join(exportDir, `${name}.mp4`);
      // 正在预览哪个版本就开哪个版本：看 v1 时点「打开成片」，应该给 v1，而不是最新那一版
      const wantV = Number(b.v) || 0;
      const cur = currentVersion(name);
      const outFile = (wantV > 0 ? versionFile(name, wantV) : cur.file)
        || path.join(ep, "hf/assets", `cam-${name}.mp4`);

      let target = String(b.path || "");
      let mode = b.mode || "open";     // open=用默认程序打开 / select=在文件夹中选中 / dir=只开目录

      // 旧调用方可能只传 path；新调用方只传 name + target，这里统一解析
      if (!target) {
        const want = b.target || "out";
        // 「打开文件夹」永远只开目录（成片交给「打开成片」），目录不存在就先建出来，
        // 否则 explorer 收到一个不存在的路径会直接没反应
        if (want === "export") {
          target = exportDir; mode = "dir";
          try { fs.mkdirSync(exportDir, { recursive: true }); } catch {}
        }
        else if (want === "assets") { target = path.join(ep, "hf/assets"); mode = "dir"; }
        else if (want === "folder") { target = path.dirname(outFile); mode = "dir"; }
        else if (fs.existsSync(outFile)) target = outFile;
        else if (fs.existsSync(exported)) target = exported;
        else if (fs.existsSync(ep)) { target = ep; mode = "dir"; }
        else return json(res, 404, { ok: false, error: "还没有成片，先跑一次剪辑" });
      }
      if (!fs.existsSync(target)) {
        // 目标是演算出来的路径但还不存在 → 退回工程目录，别让按钮点了没反应
        if (fs.existsSync(ep)) { target = ep; mode = "dir"; }
        else return json(res, 404, { ok: false, error: "路径不存在：" + target });
      }
      openWith(target, mode);
      return json(res, 200, { ok: true, target, mode });
    }

    return json(res, 404, { ok: false, error: "no route " + p });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  剪辑台 → http://127.0.0.1:${PORT}\n`);
});
