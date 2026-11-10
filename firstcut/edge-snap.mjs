// 能量吸附：把「按时间戳推算出来的切点」改成「按音频证据选出来的切点」。
//
// 为什么需要这一层（2026-11-02 实测，勿凭直觉改回去）：
//   · ASR 的逐字时间戳是**首尾相接铺满**的：103s/549 字里 509 个相邻边界 gap = 0。
//     于是 verbatim.snapRange 里 `max(prevEnd, first.s - 0.06)` 永远取 prevEnd，
//     60ms 保护一秒都没生效 —— 实际是零余量硬切在时间戳上。
//   · 时间戳本身不在音素边界上：与真实能量谷底的偏差中位 120ms、P90 190ms，
//     509 个边界里 283 个偏差 > 60ms；92.7% 的字边界处音频仍在发声（相对语音 -22dB 以内）。
//   · 前面再叠 40ms cub 淡入，中位音节才 150ms，等于砍掉整个字头。
//
// 所以这里只做一件事：给一个「大概在这里」的时间，返回「这里最像静音的地方」，
// 并告诉调用方这个位置有多少静音余量（余量决定淡入淡出能开多长）。
//
// 纯函数 + 一次性算好的 10ms 包络，不碰文件、不依赖 ffmpeg 之外的任何东西。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SR = 16000;
const FR = 160;              // 10ms/帧
export const STEP = FR / SR;

/* ── 包络 ────────────────────────────────────────────────────
 * 只取单声道 16k 原始 PCM 在内存里算 RMS，比 astats/ametadata 快两个数量级
 * （103s 素材 ~120ms，后者要写 48 万行文本）。
 */
export function buildEnvelope(audioPath, ffmpeg = "ffmpeg") {
  const r = spawnSync(ffmpeg, [
    "-v", "error", "-i", audioPath, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-",
  ], { maxBuffer: 1024 * 1024 * 512 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    throw new Error(`包络计算失败：${(r.stderr || "").toString().split("\n").slice(-2).join(" ").trim() || "无音频输出"}`);
  }
  const buf = r.stdout;
  const n = Math.floor(buf.length / 2 / FR);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    const base = f * FR * 2;
    for (let i = 0; i < FR; i++) {
      const v = buf.readInt16LE(base + i * 2) / 32768;
      acc += v * v;
    }
    db[f] = 10 * Math.log10(acc / FR + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const q = (p) => sorted[Math.floor(p * (n - 1))] ?? -100;
  const speech = q(0.9);        // 语音参考电平
  const thr = speech - 22;      // 低于它就当作「没在说话」，实测底噪比语音低 30dB 以上
  const floor = q(0.1);
  return { db, n, step: STEP, dur: n * STEP, speech, thr, floor };
}

/* 包络缓存：同一份音频只算一次。key 用 路径+大小+mtime，重跑 ASR 会变，改剪辑计划不会。 */
export function envelopeFor(ep, audioPath, ffmpeg = "ffmpeg") {
  const f = path.join(ep, "work/env-10ms.json");
  try {
    const st = fs.statSync(audioPath);
    const key = `${path.basename(audioPath)}:${st.size}:${Math.round(st.mtimeMs)}`;
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j.key === key && Array.isArray(j.db) && j.db.length) {
        const n = j.db.length;
        return { ...j, db: Float32Array.from(j.db), n, step: STEP, dur: n * STEP };
      }
    }
  } catch { /* 缓存坏掉就重算 */ }
  const env = buildEnvelope(audioPath, ffmpeg);
  try {
    const st = fs.statSync(audioPath);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({
      key: `${path.basename(audioPath)}:${st.size}:${Math.round(st.mtimeMs)}`,
      at: new Date().toISOString(), speech: +env.speech.toFixed(2), thr: +env.thr.toFixed(2),
      floor: +env.floor.toFixed(2), db: Array.from(env.db, (x) => Math.round(x * 10) / 10),
    }));
  } catch { /* 缓存写不了不影响结果 */ }
  return env;
}

const at = (env, t) => Math.max(0, Math.min(env.n - 1, Math.round(t / env.step)));
export const isQuiet = (env, i) => env.db[i] < env.thr;

/* 一个字在音频里**真正出声**的那一段（首/末个高能量帧）。
 *
 * ASR 的逐字时间戳把字尾的停顿也算进这个字：实测「吗」的 token 是 0.96s，
 * 其中只有前 0.3s 出声，剩下 0.66s 是句间静音；「啊」同样是 0.57s 的 token 只出 0.12s 声。
 * 所以判「这个字有没有被剪掉」必须看语音窗口，不能看 token 的中点 ——
 * 用中点会把「只剪掉了字后面的停顿」误判成「这个字已经删了」（用户报的「标删未删」）。
 * 返回 null = 这个 token 里一个高能量帧都没有（纯停顿/纯噪声），不当字看。
 */
export function voicedWindow(env, s, e) {
  if (!env || !(e > s)) return null;
  const a = Math.max(0, Math.floor(s / env.step));
  const b = Math.min(env.n, Math.ceil(e / env.step));
  let first = -1, last = -1;
  for (let i = a; i < b; i++) if (env.db[i] >= env.thr) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  return [+(first * env.step).toFixed(3), +Math.min(e, (last + 1) * env.step).toFixed(3)];
}

/* 从 t 往回数连续静音的长度（上限 budget） */
export function quietBack(env, t, budget = 1) {
  let i = at(env, t) - 1, n = 0;
  const max = Math.round(budget / env.step);
  while (i >= 0 && n < max && isQuiet(env, i)) { n++; i--; }
  return n * env.step;
}
/* 从 t 往后数连续静音的长度（上限 budget） */
export function quietFwd(env, t, budget = 1) {
  let i = at(env, t), n = 0;
  const max = Math.round(budget / env.step);
  while (i < env.n && n < max && isQuiet(env, i)) { n++; i++; }
  return n * env.step;
}

/* ── 吸附 ────────────────────────────────────────────────────
 * 在 t±win 内找最像切口的位置：
 *   ① 有静音段（≥2 帧）→ 落在静音内；t 本来就在静音里就原地不动
 *   ② 没有静音（连续连读）→ 取窗口内能量最低的那一帧（音节之间的谷底）
 * lo/hi 是调用方给的禁区（比如不许越过相邻字的语音核心），结果会被夹回去。
 * room = 切点两侧可用的静音余量，用于决定淡入淡出时长。
 */
export function snapByEnergy(env, t, o = {}) {
  const { win = 0.22, lo = -Infinity, hi = Infinity } = o;
  const k = at(env, t);
  const w = Math.round(win / env.step);
  const a = Math.max(0, k - w), b = Math.min(env.n - 1, k + w);

  let best = null;
  for (let i = a; i <= b;) {
    if (!isQuiet(env, i)) { i++; continue; }
    let j = i;
    while (j + 1 <= b && isQuiet(env, j + 1)) j++;
    const s = i * env.step, e = (j + 1) * env.step;
    const dist = t >= s && t <= e ? 0 : Math.min(Math.abs(s - t), Math.abs(e - t));
    if (!best || dist < best.dist) best = { s, e, dist };
    i = j + 1;
  }
  if (best && best.e - best.s >= 2 * env.step) {
    let p = t >= best.s && t <= best.e ? t : (best.s + best.e) / 2;
    const room = Math.min(p - best.s, best.e - p);
    return { t: clamp(p, lo, hi), kind: "silence", room: Math.max(0, room) };
  }
  // 连读：窗口里没有一处静音，说明这一段两个音节是连着的，切哪儿都会破。
  // 此时唯一能做的是挑**能量最低的那一帧**（最像字缝的位置），并且把搜索范围收到字缝附近 ±120ms
  // —— 放到 ±220ms 会跑到隔壁字的弱辅音里，那个位置切下去更明显。
  const vw = Math.round(Math.min(win, 0.12) / env.step);
  const va = Math.max(0, k - vw), vb = Math.min(env.n - 1, k + vw);
  let mi = va, mv = Infinity;
  for (let j = va; j <= vb; j++) if (env.db[j] < mv) { mv = env.db[j]; mi = j; }
  return { t: clamp(mi * env.step, lo, hi), kind: "valley", room: 0, gain: mv };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/* ── 接缝压缩 ────────────────────────────────────────────────
 * 句级剪的「过松」不是切点算错，而是**两侧的静音原封不动对拼**：
 * 实测 26 个拼接点接缝静音中位 0.39s、23 个 > 0.25s，合计 11.27s = 成片 12.6%。
 * 这里把每个拼接点两侧的静音各裁到 keepGap/2，保留一点点呼吸，其余剪掉。
 *
 * 只在「两段之间确实有删除」时裁（e1 < s2）：两段本来就连着的话，裁静音等于凭空造出一道跳变。
 * 段长不足 minKept 时不裁，避免把短句裁没。
 */
export function squeezeSeams(env, segs, o = {}) {
  const { keepGap = 0.12, minKept = 0.25 } = o;
  if (!Array.isArray(segs) || segs.length < 2) return segs.map((s) => [...s]);
  const out = segs.map(([s, e]) => [s, e]);
  const half = keepGap / 2;
  for (let i = 0; i < out.length - 1; i++) {
    const [s1, e1] = out[i];
    const [s2, e2] = out[i + 1];
    if (s2 - e1 < 0.002) continue;
    const tail = quietBack(env, e1, Math.max(0, e1 - s1 - minKept));
    if (tail > half) out[i][1] = e1 - (tail - half);
    const head = quietFwd(env, s2, Math.max(0, e2 - s2 - minKept));
    if (head > half) out[i + 1][0] = s2 + (head - half);
  }
  // 压缩后可能出现首尾倒挂（极短的段两侧都被裁）
  return out.filter(([s, e], i) => e - s > 0.05 || i === 0);
}

/* ── 淡入淡出时长 ────────────────────────────────────────────
 * 固定 40ms 在「零余量硬切」上会啃掉字头（中位音节 150ms，占 27%）。
 * 关键约束：fade 是从切点向**保留侧**延伸的，所以要 ≤ 那一侧的静音余量，
 * 否则淡化就压到语音上。这里 1:1 取值（不是 2:1）：余量 25ms 就给 25ms，
 * 余量 ≥40ms 才用满 40ms；没有余量（连读谷底）降到 12ms，只消爆音。
 */
export function fadeFor(room, { max = 0.04, min = 0.012 } = {}) {
  return clamp(room, min, max);
}
