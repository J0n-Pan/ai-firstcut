// 收紧气口 —— 在常规气口检测（silencedetect + 0.1s 边界内缩 + 0.2s 最短保留间隙）之上，
// 再跑一层**逐帧能量掩膜**，把成片里所有非语音区间全部剪掉。
//
// 为什么现有算法剪不干净（2026-10-31 实测，148.8s 素材）：
//   silencedetect 要求「连续低于噪声门 ≥0.35s」才算静音，而 keepGapSec=0.2 又会把
//   「剪完只剩 ≤0.2s 的缝」整段保留 —— 结果是句间那些 0.2~0.35s 的换气全部留在成片里。
//   实测该素材保留段内仍有 33.5s 低能量区间（其中 110 处 ≥0.12s），峰值 -25~-30dB，
//   相当于整片 22% 的时长是气口。光调 keepGapSec 只能治一半：真正的边界得按波形判。
//
// 这一层的判据，都基于 10ms 帧能量：
//   ① 语音参考电平 ref = 保留段内帧能量的 p90；能量低于 ref-18dB 的帧判为「非语音」。
//      实测四支素材 ref = -7.4~-9.9dB，气口落在 -25~-30dB，与语音差 18~22dB，区分度极大。
//   ② 非语音区间两端各留 guard(默认 60ms) 不放（=把段边界内缩到 guard），
//      既护住字头字尾的爆破/摩擦，又刚好把 buildCutFilter 的 40ms 交叉淡化落在静音一侧。
//   ③ 字级护卫：给了 words（ASR 逐字时间戳）时，每个字「自身峰值-10dB 以上」的帧不许剪。
//      ① 是拿全片 p90 当尺子的**绝对**门限，弱音节（嗯/么/词尾）比 p90 低 20dB 以上，
//      会和真静音落进同一档被整段剪掉 —— 表现就是「背单|词|啊」，见 wordProtectMask。
//
// 为什么不用 ASR 逐字时间戳当边界：paraformer 的句尾字时长会把尾巴一路拉到句末
// （实测「吗」占 4.76~5.72s，0.96s），拿它当语音边界会把气口原样留下。
// ③ 只借它判「这个字在不在出声」，不借它当边界，所以 padding 不影响收气口。
// 能量掩膜本身不需要转写，`--no-retake` 时同样有效（此时 ③ 自动跳过）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const FRAME_SEC = 0.01;
const SR = 16000;
const SAMPLES = Math.round(SR * FRAME_SEC);

export const TIGHT_DEFAULTS = {
  frameSec: FRAME_SEC,
  sampleRate: SR,
  refDb: 18,          // 语音参考电平之下的容差（dB）：低于 ref-18dB 的帧算「非语音」，可剪
  wordGuardDb: 10,    // 字级护卫：一个字「自身峰值 -10dB」以上的帧不许剪，见 §字级护卫
  guardSec: 0.06,     // 每个切口两侧保留的静音（必须 ≥ 交叉淡化 40ms；帧网格吸附还要吃掉 ≤10ms）
  minRunSec: 0.06,    // 段内非语音区间达到这个长度才剪（更短的属于字间过渡）
  minPieceSec: 0.02,  // 剪完剩下不足这么长的碎片直接丢弃
  maxShrinkRatio: 0.55, // 安全阀：剪掉超过这个比例的保留时长 → 判为判据失准，放弃收紧
};

/** 把素材解成 16k 单声道 s16le 落盘（-vn：只要音频，不等视频解码） */
function decodePcm(ffmpeg, input, outPath) {
  return spawnSync(ffmpeg, ["-y", "-v", "error", "-i", input, "-vn",
    "-ac", "1", "-ar", String(SR), "-f", "s16le", outPath], { encoding: "utf8", maxBuffer: 16e6 });
}

/** 逐帧 RMS（dBFS） */
function frameDb(pcm, frameSec) {
  const n = Math.floor(pcm.length / SAMPLES);
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * SAMPLES;
    for (let j = 0; j < SAMPLES; j++) {
      const v = pcm[base + j] / 32768;
      sum += v * v;
    }
    db[i] = 20 * Math.log10(Math.sqrt(sum / SAMPLES) + 1e-9);
  }
  return db;
}

const pct = (arr, q) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
};

/* 字级护卫（2026-11-10）：把每个字的「有声帧」标出来，这些帧一律不许剪。
 *
 * 为什么不能只调全局门限：ref-18dB 是相对**语音 p90** 定的绝对门限，而鼻音、
 * 轻辅音音节（嗯/么/词尾）比 p90 低 20~25dB —— 它们和真静音落进同一档，
 * 于是一刀切在字中间，听起来就是「背单|词|啊」「该怎|么|办」。把门限抬到
 * ref-24dB 能挡住大部分，但同一句里音量正常的字也少剪了（实测剪除量掉 32%）。
 *
 * 真正的判据得按**字**看：一个字「自身峰值-10dB」以上的帧就是它在出声，
 * 不管它比全片 p90 低多少。用相对峰值而不是绝对值，是因为 ASR 会把这个字
 * 后面的停顿也算进 token（「吗」占 0.96s 里只有 0.3s 出声），用 token 边界
 * 保护会把整个气口锁死；用峰值-10dB 判，token 里的停顿自然不进护卫。
 *
 * guard 与用户参数一致：护卫帧两侧再各扩 G 帧，让切口的交叉淡化也躲开声音。
 */
function wordProtectMask(words, db, F, G, marginDb) {
  const m = new Uint8Array(db.length);
  for (const w of words) {
    if (!w || !(w.e > w.s)) continue;
    const a = Math.max(0, Math.floor(w.s / F));
    const b = Math.min(db.length, Math.ceil(w.e / F));
    let peak = -Infinity;
    for (let k = a; k < b; k++) if (db[k] > peak) peak = db[k];
    if (!Number.isFinite(peak)) continue;
    const lim = peak - marginDb;
    for (let k = a; k < b; k++) {
      if (db[k] < lim) continue;
      const x = Math.max(0, k - G), y = Math.min(db.length - 1, k + G);
      for (let q = x; q <= y; q++) m[q] = 1;
    }
  }
  return m;
}

/**
 * 收紧：把 segs 里所有非语音区间剪掉。
 * @param {Array<[number,number]>} segs 保留段（原片时间，秒）
 * @param {Float64Array} db 逐帧 dB
 * @param {object} opt
 * @returns {{segs:Array<[number,number]>, cuts:Array<[number,number]>, stats:object}}
 */
export function tightenSegs(segs, db, opt = {}) {
  const o = { ...TIGHT_DEFAULTS, ...opt };
  const F = o.frameSec;
  const G = Math.max(1, Math.round(o.guardSec / F));
  if (!Array.isArray(segs) || !segs.length || !db.length) {
    return { segs, cuts: [], stats: { applied: false, reason: "空输入" } };
  }
  const t0 = Date.now();
  const before = segs.reduce((a, [s, e]) => a + e - s, 0);

  // 语音参考电平只统计保留段内，避免片头片尾的长静音把 p90 拉低
  const inside = [];
  for (let i = 0; i < db.length; i++) {
    const t = i * F;
    if (segs.some(([s, e]) => t >= s && t < e)) inside.push(db[i]);
  }
  const ref = pct(inside, 0.9);
  const th = ref - o.refDb;
  if (!Number.isFinite(ref)) return { segs, cuts: [], stats: { applied: false, reason: "无有效音频帧" } };

  // 有声帧 → 两侧各扩 guard 帧（保住字头字尾）；其余都是可剪区
  const keepMask = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) {
    if (db[i] < th) continue;
    const a = Math.max(0, i - G), b = Math.min(db.length - 1, i + G);
    for (let k = a; k <= b; k++) keepMask[k] = 1;
  }

  // 字级护卫：全局门限挡不住的弱音节（比语音 p90 低 20dB 以上）由「这个字自己在出声」保住。
  // 传了 words 才启用；没传就退回纯能量掩膜（行为与 2026-10-31 版一致）。
  let protectedSec = 0;
  if (Array.isArray(o.words) && o.words.length) {
    const wm = wordProtectMask(o.words, db, F, G, o.wordGuardDb);
    for (let i = 0; i < db.length; i++) if (wm[i] && !keepMask[i]) { keepMask[i] = 1; protectedSec += F; }
  }

  const out = [], cuts = [];
  let edgeTrim = 0, innerCut = 0;
  for (const [S, E] of segs) {
    const a = Math.max(0, Math.floor(S / F));
    // 只扫「帧起点 < E」的帧。原来写 ceil(E/F)，当 E 不落在帧边界上时最后一帧
    // 的起点会越过 E，剪出来就是 [21.775, 21.774] 这种零长/反向切口（下游 buildCutFilter 会当成坏区间）。
    const b = Math.min(db.length, Math.floor(E / F) + 1);
    if (b <= a) continue;
    let cur = a, i = a;
    while (i < b) {
      if (keepMask[i]) { i++; continue; }
      let j = i;
      while (j < b && !keepMask[j]) j++;
      const run = (j - i) * F;
      const atEdge = (i === a) || (j === b);
      // 段首/段尾的残余一律剪（那里本来就已经在剪切口上）；段中间的只剪够长的
      if (atEdge || run >= o.minRunSec) {
        const cs = i * F, ce = Math.min(j * F, E);
        if (i > cur) out.push([cur * F, Math.min(i * F, E)]);
        // 到毫秒精度后还得有长度：段尾 E 落在帧中间时，最后一刀可能只剩不到半帧，
        // 四舍五入后就成了 [45.420,45.420] 这种零长切口。
        if (+ce.toFixed(3) - +cs.toFixed(3) >= F / 2) {
          cuts.push([+cs.toFixed(3), +ce.toFixed(3)]);
          if (atEdge) edgeTrim += ce - cs; else innerCut += ce - cs;
        }
        cur = j;
      }
      i = j;
    }
    if (cur < b) out.push([cur * F, Math.min(b * F, E)]);
  }

  // 去掉剪完的碎片与重叠
  const clean = [];
  for (const [s, e] of out) {
    if (e - s < o.minPieceSec) continue;
    const last = clean[clean.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else clean.push([+s.toFixed(3), +e.toFixed(3)]);
  }
  const after = clean.reduce((a, [s, e]) => a + e - s, 0);
  const stats = {
    applied: true, refDb: +ref.toFixed(1), thresholdDb: +th.toFixed(1),
    guardSec: o.guardSec, minRunSec: o.minRunSec, wordGuardDb: o.wordGuardDb,
    wordProtectedSec: +protectedSec.toFixed(2),
    beforeSec: +before.toFixed(2), afterSec: +after.toFixed(2), savedSec: +(before - after).toFixed(2),
    segsBefore: segs.length, segsAfter: clean.length,
    cuts: cuts.length, edgeTrimSec: +edgeTrim.toFixed(2), innerCutSec: +innerCut.toFixed(2),
    ms: Date.now() - t0,
  };

  // 安全阀：判据失准时宁可不动。整片都是音乐/强底噪时 ref 会被拉高，
  // 掩膜会把真正的语音也当非语音 —— 表现为「剪掉一半以上」，这时直接放弃。
  if (before > 0 && after < before * (1 - o.maxShrinkRatio)) {
    return {
      segs, cuts: [],
      stats: { ...stats, applied: false, reason: `剪掉超过 ${(o.maxShrinkRatio * 100).toFixed(0)}% 的保留时长，判为判据失准，已放弃` },
    };
  }
  return { segs: clean, cuts, stats };
}

/**
 * 一步到位：解码 → 逐帧能量 → 收紧。
 * @param {{ffmpeg:string, input:string, segs:Array, tmpPcm:string, words?:Array<{s:number,e:number,c?:string}>, opt?:object}} p
 */
export function tightenFile(p) {
  const o = { ...TIGHT_DEFAULTS, ...(p.opt || {}) };
  if (Array.isArray(p.words) && p.words.length && !o.words) o.words = p.words;
  const r = decodePcm(p.ffmpeg, p.input, p.tmpPcm);
  if (r.status !== 0) {
    return { segs: p.segs, cuts: [], stats: { applied: false, reason: "音频解码失败: " + String(r.stderr || "").slice(-160) } };
  }
  let pcm;
  try {
    const buf = fs.readFileSync(p.tmpPcm);
    // Buffer 的 byteOffset 不保证 2 字节对齐 → 拷一份保证 Int16Array 视图合法
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 2));
    pcm = new Int16Array(ab);
  } catch (e) {
    return { segs: p.segs, cuts: [], stats: { applied: false, reason: "读不到解码结果: " + e.message } };
  } finally {
    try { fs.unlinkSync(p.tmpPcm); } catch {}
  }
  const db = frameDb(pcm, o.frameSec);
  return tightenSegs(p.segs, db, o);
}
