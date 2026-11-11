#!/usr/bin/env node
// 从剪切计划重导出成片 —— 只跑 ffmpeg，不碰 ASR / LLM。
//
//   node firstcut/reexport.mjs --name cloud-v10-c0793 [--out D:/out/x.mp4]
//
// 为什么必须单独有这一支：剪辑台的审核决定不能触发重跑管线。重跑一次 = 3 分钟 + 约 ¥0.02，
// 而且 qwen 的结论会漂（实测同一处 #12 在 v8 判 ok、v9 判 offtopic，temperature=0 也挡不住）。
// 用户改一条、别处跟着变，这个功能就没人敢用。所以：裁决结果冻结在 cut-plan.json 里，
// 审核只往 overrides.json 里加「还要删掉哪些区间」，本脚本按区间从 segs 里减掉重剪。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyDecisions } from "./review-clip.mjs";
import { homeOf } from "./home.mjs";
import { resolveFf } from "./ffbin.mjs";
import { buildCutFilter, trimCutsToVoice } from "./cutfilters.mjs";
import { envelopeFor, squeezeSeams } from "./edge-snap.mjs";
import { readDoc, repairVerbatimCuts } from "./verbatim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 工程数据在数据目录，不在程序目录（换版本时程序目录会被整体替换）
const HOME = homeOf(ROOT);
const R = JSON.parse(fs.readFileSync(path.join(HERE, "rules.json"), "utf8"));
// 与 run.mjs 共用同一套定位规则（环境变量 → 程序目录自带 runtime → PATH）
const FF = resolveFf({ root: ROOT });
const FFMPEG = FF.ffmpeg;
const FFPROBE = FF.ffprobe;

const args = process.argv.slice(2);
const getOpt = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const NAME = getOpt("--name");
if (!NAME) {
  console.error("用法: node firstcut/reexport.mjs --name <episode> [--out <file>]");
  process.exit(2);
}
const EP = path.join(HOME, "episodes", NAME);
const planPath = path.join(EP, "work/cut-plan.json");
if (!fs.existsSync(planPath)) {
  console.error(`找不到 ${path.relative(HOME, planPath)}`);
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const input = plan.input;
if (!input || !fs.existsSync(input)) {
  console.error(`剪切计划里没有可用的原片路径：${input || "(空)"}`);
  process.exit(2);
}

// ── 读决定：只认「还要删掉」的区间集合，不做区间恢复 ──
// 审核队列里的条目都是"护栏没让删"的地方，所以决定只有两种效果：多删一点 / 什么都不做。
const ovPath = path.join(EP, "work/overrides.json");
let decisions = [];
if (fs.existsSync(ovPath)) {
  try {
    const ov = JSON.parse(fs.readFileSync(ovPath, "utf8"));
    decisions = Array.isArray(ov.decisions) ? ov.decisions : [];
  } catch (e) {
    console.error(`overrides.json 解析失败：${e.message}`);
    process.exit(2);
  }
}
// 与 server 同一套修复：老数据里「只削掉半个字」的逐字切口先扩到整字，
// 否则稿子上写着已删、成片里那个语气词还在（用户报的 bug）。
try {
  const rep = repairVerbatimCuts(decisions, readDoc(EP).words);
  if (rep.fixed.length) {
    decisions = rep.decisions;
    console.log(`修复 ${rep.fixed.length} 处过窄的逐字切口：${rep.fixed.map((f) => `${f.text || "?"} ${f.from.join("-")}→${f.to.join("-")}`).join("；")}`);
  }
} catch { /* 没有逐字稿（不是逐字剪工程）就跳过 */ }
const extra = [];
for (const d of decisions) {
  if (d.choice !== "cut") continue;
  for (const r of d.cuts || []) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const a = Number(r[0]), b = Number(r[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    extra.push([a, b]);
  }
}

const before = plan.segs.map(([s, e]) => [s, e]);
// 与 server 共用同一套减法：基线计划不动，决定是增量 → 反复重剪不会越剪越短
let segs = applyDecisions(before, decisions);

const durOf = (ss) => ss.reduce((a, [s, e]) => a + (e - s), 0);
const d0 = durOf(before);
let d1 = durOf(segs);
console.log(`原计划 ${before.length} 段 / ${d0.toFixed(2)}s → 注入 ${extra.length} 个区间后 ${segs.length} 段 / ${d1.toFixed(2)}s`);

if (!segs.length) {
  console.error("重剪后一个片段都不剩，已中止（请检查决定是否覆盖了整片）");
  process.exit(3);
}

// ── 生成滤镜图（与 run.mjs 共用 cutfilters：单链 select，含拼接点淡化）──
const SPEED = plan.speed || 1;
// fade 优先级：环境变量 > rules.json > 计划里冻结的值。
// 为什么不优先用 plan.fade：它是首剪那一刻的参数快照，等于把旧的淡化算法永久钉在老工程上 ——
// 改好 cutfilters 后，老工程重剪还是"生硬"的老样子，用户会觉得修复没生效。
// fade 只影响拼接处的平滑度，不改内容也不改时长，所以跟着版本走没有副作用。
const FADE = Math.max(0, Number(process.env.XUNJIAN_EDGE_FADE ?? R.segment.edgeFadeSec ?? plan.fade ?? 0));
// 接缝静音压缩：与首剪同一套逻辑（见 run.mjs 同名块）。重剪时 decisions 只删"文字区间"，
// 两侧静音会原样对拼出 0.3~0.5s 空白 —— 每次重剪都重新压一遍，老工程重剪也能变紧凑。
// ⚠️ 顺序：先压接缝，再探帧率，最后交给 buildCutFilter（内部先 snap 再逐点算 fade）。
//   压完段边界会变，帧率探测只依赖输入文件，两者互不影响，但 fade 必须看最终边界。
let ENV = null;
{
  const wav = path.join(EP, "work/raw-asr.wav");
  if (fs.existsSync(wav)) {
    try {
      ENV = envelopeFor(EP, wav, FFMPEG);
      const seamGap = Number(R.segment.seamGapSec ?? 0.12);
      const sq = squeezeSeams(ENV, segs, { keepGap: seamGap, minKept: R.segment.minKeptSec });
      const dz = durOf(segs) - durOf(sq);
      segs = sq;
      d1 = durOf(segs);   // 落盘的 outDur 必须与压缩后的 segs 对齐，否则时间轴映射会偏
      if (dz > 0.02) console.log(`  接缝静音压缩 ${dz.toFixed(2)}s（气口留 ${Math.round(seamGap * 1000)}ms）`);
    } catch (e) { console.log(`  ⚠️ 包络不可用，跳过接缝压缩: ${e.message}`); }
  }
}
// 半字收口（与首剪同一套，见 cutfilters.trimCutsToVoice）：只看语音，
// 语音被削掉一半以上的字把剩下的那点剪干净；语音基本还在的字不碰。
try {
  const sw = trimCutsToVoice(segs, readDoc(EP).words, ENV);
  if (sw.fixed.length) {
    const dz = durOf(segs) - durOf(sw.segs);
    segs = sw.segs;
    d1 = durOf(segs);
    console.log(`  半字收口 ${sw.fixed.length} 处（多剪 ${dz.toFixed(2)}s）：` +
      sw.fixed.slice(0, 8).map((f) => `${f.text}@${f.at}s(+${f.wound.toFixed(2)})`).join(" ") + (sw.fixed.length > 8 ? " …" : ""));
  }
} catch (e) { console.log(`  ⚠️ 没有逐字稿/包络，跳过半字收口: ${e.message}`); }
// 帧率：老计划没有 fps 字段 → 现探一次。缺了它，段边界不会被吸附到帧网格，
// 段数一多（收紧气口后 90+ 段）音视频各按自己的网格取整，累计能差出 0.7s。
const FPS = (() => {
  if (Number(plan.fps) > 1) return Number(plan.fps);
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=r_frame_rate", "-of", "csv=p=0", input], { encoding: "utf8" });
  const [a, b] = String(r.stdout || "").trim().split("/").map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 1 ? +v.toFixed(3) : 0;
})();
const fc = buildCutFilter(segs, { speed: SPEED, fade: FADE, fps: FPS, env: ENV });

// ── 版本链：每次重剪都产出一个新文件，绝不覆盖上一版 ──
// 为什么必须：审核决定本来就要来回试，"删了这 6 秒会不会太长"只能靠对比听出来。
// 若同名覆盖，磁盘上永远只剩最后一次，用户没法 A/B。v1 是首剪的原名（保持兼容），v2 起带版本号。
const verPath = path.join(EP, "work/versions.json");
function readVersions() {
  if (!fs.existsSync(verPath)) return { name: NAME, current: 0, items: [] };
  try {
    const j = JSON.parse(fs.readFileSync(verPath, "utf8"));
    if (!Array.isArray(j.items)) j.items = [];
    return j;
  } catch { return { name: NAME, current: 0, items: [] }; }
}
const vers = readVersions();
const v1file = path.join(EP, "hf/assets", `cam-${NAME}.mp4`);
// 老工程（或首剪还没写版本档）→ 按磁盘上的产物补记 v1，别让历史从 v2 开始
if (!vers.items.some((x) => Number(x.v) === 1) && fs.existsSync(v1file)) {
  const st = fs.statSync(v1file);
  const probe = spawnSync(FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", v1file],
    { encoding: "utf8", windowsHide: true });
  const d1v = Number(String(probe.stdout || "").trim());
  vers.items.push({ v: 1, file: `hf/assets/cam-${NAME}.mp4`, kind: "cut", at: st.mtime.toISOString(),
    dur: Number.isFinite(d1v) && d1v > 0 ? +d1v.toFixed(3) : null, segs: null, size: st.size,
    note: "首剪（按磁盘产物补记）" });
  vers.items.sort((a, b) => a.v - b.v);
}
// 取「已登记的最大值」与「磁盘上已存在的最大文件号」两者的较大值 +1，避免中断后编号复用
let vNext = 1;
for (const it of vers.items) if (Number(it.v) >= vNext) vNext = Number(it.v) + 1;
for (let guard = 0; guard < 500; guard++) {
  if (!fs.existsSync(path.join(EP, "hf/assets", `cam-${NAME}.v${vNext}.mp4`))) break;
  vNext++;
}

const explicitOut = getOpt("--out");
const camFinal = explicitOut
  ? path.resolve(explicitOut)
  : path.join(EP, "hf/assets", `cam-${NAME}.v${vNext}.mp4`);
// 和代理同一套办法：ffmpeg 边转边写，中途「文件已存在但没写完」。
// 剪辑台会扫 hf/assets 找版本，扫到一个半截文件就会把它当可播版本 → 点开白屏。
// 所以先写 .part.mp4，转完再原子改名；扫描的正则也天然不匹配 .part.mp4。
const cam = explicitOut ? camFinal : camFinal.replace(/\.mp4$/i, ".part.mp4");
if (explicitOut) console.log(`（--out 指定输出，跳过版本登记）`);

fs.writeFileSync(path.join(EP, "work/cutfc.applied.txt"), fc);
const applied = { name: NAME, v: explicitOut ? null : vNext, input, appliedAt: new Date().toISOString(),
  segs, outDur: +d1.toFixed(3), extraCuts: extra, decisions: decisions.length };
fs.writeFileSync(path.join(EP, "work/cut-plan.applied.json"), JSON.stringify(applied, null, 1));
if (!explicitOut) {
  // 每版留一份快照，否则回溯"上一版到底剪了哪些段"只能靠猜
  try {
    fs.writeFileSync(path.join(EP, `work/cut-plan.applied.v${vNext}.json`), JSON.stringify(applied, null, 1));
  } catch {}
}
fs.mkdirSync(path.dirname(cam), { recursive: true });
const cutArgs = (fcArgs) => ["-y", "-v", "error", "-i", input, ...fcArgs,
  "-map", "[vf]", "-map", "[af]", "-c:v", "libx264", "-crf", `${R.encode.crf}`, "-preset", `${R.encode.preset}`,
  "-pix_fmt", "yuv420p", "-g", `${R.encode.gopFrames}`, "-c:a", "aac", "-b:a", `${R.encode.audioBitrate}`, cam];
let r = spawnSync(FFMPEG, cutArgs(["-filter_complex_script", path.join(EP, "work/cutfc.applied.txt")]), { encoding: "utf8" });
if (r.status !== 0 && /Unrecognized option 'filter_complex_script'/.test(r.stderr || "")) {
  r = spawnSync(FFMPEG, cutArgs(["-filter_complex", fc.replace(/\n/g, "")]), { encoding: "utf8" });
}
if (r.status !== 0) {
  console.error("重剪失败：" + String(r.stderr || "").slice(-400));
  if (!explicitOut) { try { fs.unlinkSync(cam); } catch {} }   // 别在版本链里留一个半截文件
  process.exit(1);
}

// 响度归一（与首剪一致，成片换了下游还会读 voice-norm.wav）
const voice = path.join(EP, "work/voice-norm.wav");
const rn = spawnSync(FFMPEG, ["-y", "-v", "error", "-i", cam, "-vn", "-af", `loudnorm=${R.encode.loudnorm}`, "-ar", "48000", voice], { encoding: "utf8" });
if (rn.status !== 0) console.warn("⚠️ loudnorm 失败（不影响成片）：" + String(rn.stderr || "").slice(-200));

// 原子改名：从这一刻起，这个版本才对扫描可见
if (!explicitOut) {
  try { fs.unlinkSync(camFinal); } catch {}
  fs.renameSync(cam, camFinal);
}

// 登记到版本链。只有 ffmpeg 真的成功了才写，否则 current 会指向一个坏文件
if (!explicitOut) {
  vers.items.push({
    v: vNext,
    file: path.relative(EP, camFinal).replace(/\\/g, "/"),
    kind: "reexport",
    at: new Date().toISOString(),
    dur: +d1.toFixed(3),
    segs: segs.length,
    decisions: decisions.length,
    cuts: extra.length,
    cutsDur: +extra.reduce((a, [s, e]) => a + (e - s), 0).toFixed(3),
    note: extra.length ? `按决定重剪 · 删 ${extra.length} 处 ${extra.reduce((a, [s, e]) => a + (e - s), 0).toFixed(2)}s` : "按决定重剪 · 未新增删除",
  });
  vers.items.sort((a, b) => a.v - b.v);
  vers.current = vNext;
  vers.name = NAME;
  fs.writeFileSync(verPath, JSON.stringify(vers, null, 1));
}

console.log(`✅ 重剪完成：${camFinal}`);
console.log(`   第 ${explicitOut ? "?" : vNext} 版 · 新时长 ${d1.toFixed(2)}s（原 ${d0.toFixed(2)}s，差 ${(d1 - d0).toFixed(2)}s）`);
