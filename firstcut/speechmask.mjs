// 语音电平分析 —— 给「低电平整句判废」和「无字底噪判废」提供逐帧能量。
//
// 为什么需要这一层（2026-11-10 实测）：
//   气口检测（silencedetect）和收紧气口（tight-breath）都只看能量，不看转写。
//   结果是同一件事的两个方向都出错：
//
//   a) 整句压着音量说 → 被 energy 层当静音，剪成碎片
//      C0793 #8「这果免费送价值一千多万就不能说是吧？」17 个字连续覆盖 78.02–81.40，
//      句内 p90 −35.6dB，全片语音参考 −11.5dB，差 24.1dB；
//      气口 removed 为 [75.22,80.31] + [80.42,84.39]，字时长 97% 落在删除区，
//      成片只剩 0.11s「就不」——听感就是句子被切碎，事后查不出是哪一刀。
//
//   b) 句尾纯底噪 → 电平刚好卡在门限上方，被当语音保留
//      DJI 结尾 89.23–90.63 共 1.4s，p50 −48.5dB，speechRef −31.5dB（这片整体就轻），
//      差 17dB，却因为 tight 门限是 ref−18dB 只差 1dB 而留下来。
//
// 两件事的正确处理都不是「保护碎片」，而是**按整句判废、整段删干净**：
//   用户要的是「这句不要」，不是「这句留 3 个字」。
//   判废后整段从 segs 扣除，energy 层再也切不到它，自然不会产生碎片。
//
// 基准为什么用「每段 p90 的中位数」而不是全片 mean_volume：
//   mean_volume 把大段静音算进分母，实测 DJI 全片 mean −35.5 而语音 p90 是 −31.5；
//   C0793 mean 更低。用中位数还能避免个别长句（15.3s 的 #5）主导基准。

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SR = 16000;
const FRAME_SEC = 0.01;
const SAMPLES = Math.round(SR * FRAME_SEC);

export const SPEECH_DEFAULTS = {
  frameSec: FRAME_SEC,
  sampleRate: SR,
  dropDb: 15,          // 段「分窗 p90 中位数」比语音参考低这么多 → 判低电平整句
  maxPeakDb: 6,        // 但允许最多一个窗高出这么多（防止半句突然恢复正常被误判）
  minSegSec: 1.5,      // 太短的句子不做判废（「嗯」「对」本来就该由别的通道处理）
  minFrames: 50,       // 至少 0.5s 有效帧
  gapSec: 1.0,         // 无字区间达到这个长度才考虑判底噪（DJI 结尾那段 1.4s，短于此的多半是正常换气）
  gapDropDb: 12,       // 无字区间 p90 低于语音参考这么多 → 判底噪（DJI 实测 p90 低 13.1dB，取 12 留 1dB 余量）
};

const pct = (arr, q) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
};

/** 解码成 16k 单声道 s16le 并算逐帧 RMS(dB)。-vn 跳过视频解码（比全解码快 6.9×）。 */
export function decodeEnvelope({ ffmpeg, input, outPath, frameSec = FRAME_SEC }) {
  const r = spawnSync(ffmpeg, ["-y", "-v", "error", "-i", input, "-vn",
    "-ac", "1", "-ar", String(SR), "-f", "s16le", outPath], { encoding: "utf8", maxBuffer: 16e6 });
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    return { db: new Float64Array(0), frameSec, error: (r.stderr || "解码失败").slice(0, 200) };
  }
  const buf = fs.readFileSync(outPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 2));
  const pcm = new Int16Array(ab);
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
  return { db, frameSec };
}

/** 某个时间区间的能量分位。区间按帧网格取整，越界自动裁剪。
 *
 * 除了整体分位，还给「分窗 p90」：
 * 把区间按 0.5s 切窗，每窗算 p90，再看这些窗 p90 的中位数与最大值。
 * 这是判断「整句都低」还是「半句低」的正确尺子 ——
 * 直接看 p90−p10 不行：句内字与字之间本来就有 0.15~0.3s 的换气缝，
 * p10 会被拉到 −50dB 以下，正常句和低电平句的跨度都是 10~15dB（实测 C0793 全片如此）。
 */
export function rangeStats(db, s, e, frameSec = FRAME_SEC) {
  const a = Math.max(0, Math.floor(s / frameSec));
  const b = Math.min(db.length, Math.ceil(e / frameSec));
  if (b <= a) return { n: 0, p10: NaN, p50: NaN, p90: NaN, p95: NaN, winP90Med: NaN, winP90Max: NaN, wins: 0 };
  const seg = db.subarray(a, b);
  const winFrames = Math.max(10, Math.round(0.5 / frameSec));
  const winP90 = [];
  for (let i = 0; i < seg.length; i += winFrames) {
    const w = seg.subarray(i, Math.min(seg.length, i + winFrames));
    if (w.length >= Math.max(10, Math.round(0.2 / frameSec))) winP90.push(pct(w, 0.9));
  }
  return {
    n: seg.length,
    p10: pct(seg, 0.1), p50: pct(seg, 0.5), p90: pct(seg, 0.9), p95: pct(seg, 0.95),
    winP90Med: winP90.length ? pct(winP90, 0.5) : NaN,
    winP90Max: winP90.length ? Math.max(...winP90) : NaN,
    wins: winP90.length,
  };
}

/** 全片语音参考：各句段 p90 的**中位数**。比全片 mean_volume 更贴近「正常说话的响度」。 */
export function pickSpeechRef(perSeg) {
  const vals = perSeg.map((x) => x && x.p90).filter((x) => Number.isFinite(x));
  return vals.length ? pct(vals, 0.5) : NaN;
}

/**
 * 低电平整句判废。
 * 命中后调用方应把 [s,e] **整段**从 segs 扣除并加入 cuts —— 不是收缩碎片区。
 * @returns {{hits:Array, report:object}}
 */
export function classifyLowLevel(perSeg, ref, opt = {}) {
  const o = { ...SPEECH_DEFAULTS, ...opt };
  const hits = [];
  if (!Number.isFinite(ref)) return { hits, report: { applied: false, reason: "无有效语音参考" } };
  for (const x of perSeg) {
    if (!x || !(x.e > x.s)) continue;
    const dur = x.e - x.s;
    if (dur < o.minSegSec) continue;
    if (!(x.n >= o.minFrames)) continue;
    if (!Number.isFinite(x.winP90Med) || !Number.isFinite(x.winP90Max)) continue;
    const dropMed = ref - x.winP90Med;
    const dropMax = ref - x.winP90Max;
    if (dropMed < o.dropDb) continue;
    // 整句都低：最响的那个 0.5s 窗口也要明显低于参考。
    // 半句正常的句子（前半低、后半回到正常音量）dropMax 会接近 0，在这里被挡掉。
    if (dropMax < o.dropDb * 0.6) continue;
    hits.push({
      i: x.i, s: x.s, e: x.e, dur,
      p90: x.p90, p50: x.p50,
      winP90Med: +x.winP90Med.toFixed(1), winP90Max: +x.winP90Max.toFixed(1),
      dropDb: +dropMed.toFixed(1), dropMaxDb: +dropMax.toFixed(1),
      text: x.text || "",
    });
  }
  return {
    hits,
    report: {
      applied: true, ref: +ref.toFixed(1), dropDb: o.dropDb,
      scanned: perSeg.length, hits: hits.length,
    },
  };
}

/**
 * 无字底噪判废：在**保留段内部**找连续无字的区间，电平明显低于语音参考就判底噪。
 *
 * 只处理 segs 内部的区间 —— 段间的静音早被气口剪掉了，不需要这里再管。
 * 字区间用 ASR 逐字时间戳；字与字之间的缝（多数 0.05~0.3s）远小于 gapSec，不会误判。
 *
 * 为什么不担心 ASR 漏字：判据要求 ≥1.0s **完全没有任何字** + 电平低于 ref−12dB。
 * 漏一个字只会产生 ~0.2s 的缝，达不到 1.0s；真漏一整句属于 ASR 质量问题，
 * 由「低电平整句」那条兜底。
 */
export function classifySilentGap({ db, segs, words, dur, ref, opt = {} }) {
  const o = { ...SPEECH_DEFAULTS, ...opt };
  const hits = [];
  if (!Number.isFinite(ref) || !db.length) return { hits, report: { applied: false, reason: "无有效语音参考" } };

  // 字区间并集：用于快速判断某个时间点有没有字
  const spans = (words || [])
    .filter((w) => w && w.e > w.s)
    .map((w) => [w.s, w.e])
    .sort((x, y) => x[0] - y[0]);
  const covered = (t) => {
    // spans 有序，线性扫足够（单次调用只有几十个区间）
    for (let k = 0; k < spans.length; k++) {
      if (t < spans[k][0]) return false;
      if (t < spans[k][1]) return true;
    }
    return false;
  };

  const F = o.frameSec;
  for (const [s, e] of segs || []) {
    let runStart = null;
    // 逐帧扫描：帧中心落在字区间内即视为有声
    const a = Math.max(0, Math.floor(s / F));
    const b = Math.min(db.length, Math.ceil(e / F));
    for (let k = a; k <= b; k++) {
      const t = k * F;
      const voice = k < b && covered(t + F / 2);
      if (!voice && runStart == null) runStart = t;
      if ((voice || k === b) && runStart != null) {
        const gapEnd = voice ? t : Math.min(e, dur ?? t);
        const len = gapEnd - runStart;
        if (len >= o.gapSec) {
          const st = rangeStats(db, runStart, gapEnd, F);
          if (Number.isFinite(st.p90) && ref - st.p90 >= o.gapDropDb) {
            hits.push({
              s: +runStart.toFixed(3), e: +gapEnd.toFixed(3), dur: +len.toFixed(2),
              p90: st.p90, dropDb: +(ref - st.p90).toFixed(1),
            });
          }
        }
        runStart = null;
      }
    }
  }
  return {
    hits,
    report: {
      applied: true, ref: +ref.toFixed(1), gapSec: o.gapSec, gapDropDb: o.gapDropDb,
      segs: (segs || []).length, hits: hits.length,
    },
  };
}
