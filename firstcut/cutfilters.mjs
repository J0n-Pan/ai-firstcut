// 合片滤镜图 —— 首剪(run.mjs)与重剪(reexport.mjs)共用同一份，避免两边逻辑漂移。
//
import { quietBack, quietFwd, fadeFor, voicedWindow } from "./edge-snap.mjs";
// 历史坑：原先是「每段一条 [0:v]trim=s:e;… + concat」，12 段就是 12 条并行分支。
// ffmpeg 会为每条分支缓存帧，commit 内存以 ~0.3GB/s 线性上涨：
//   实测同一素材 12 段，第 1 秒 5.28GB → 第 4 秒 6.15GB，工作集 950MB→1820MB，
//   跑满一分钟冲到 21GB；8GB 机器上直接把页面文件吃干 →
//   系统事件「虚拟内存不足」→ DWM 崩溃(0xc00001ad) → 整台机器上的任务全灭。
// 现在改成单链 select/aselect：只有一条链，内存恒定（实测 commit 4.77GB、工作集 432MB，不随进度涨）。
//
// 切口淡化：硬切会让波形突跳，成片转写会把它"听"成辅音、幻觉出一个不存在的词（实测「保护」）；
// 听感上就是"啪"的一声 + 硬拼。这里每个拼接点做**对称 V 形**：拼接点前 fade 秒淡出到 0，
// 点后 fade 秒淡入回 1。
//
// ⚠️ 为什么不再用 volume 表达式（v1.1.1 及以前的做法）：
//   `volume='if(lt(abs(t-T),f),abs(t-T)/f,1)':eval=frame` 是按**音频帧**（1024 样本 ≈ 21.3ms）
//   采样 t 的，而 T 一般不在帧边界上 —— 相邻两帧的增益可能从 0.33 直接跳到 1.0，
//   既没压到 0（咔哒还在），又自己造了一个新的阶跃。实测把 f 提到 60ms 也只是把残余阶跃变小。
//   改成 afade + enable：afade 是**采样级**连续曲线，实测 1.450s→1.500s 真降到 -180dB，
//   1.500s→1.563s 平滑回升；enable 关闭时滤镜直通（增益 1），所以多段串联互不干扰。
//
// ⚠️ 曲线选 cub（三次方）：fade out 的增益是 (1-x)³，在最后 6ms 已经掉到 -62dB，
//   实测对比（点前 6ms 残留）：qsin -29.6dB / tri -33.4dB / hsin -40.7dB / qua -48.3dB / cub -62.4dB。
//   qsin 是"前慢后更慢"，恰好把最该压的末段留在满幅附近 —— 30ms 版本跨点残留只有 -15dB，
//   实测两个切在满幅语音中间的拼接点（原片 27.13 / 120.59）听起来就是"啪"。
//   exp 虽然能到 -180dB，但前 6ms 就掉了 40dB，像"突然没声"，语音上像吞字。
//   时长取 40ms：短到听不出凹陷，又足够覆盖 aselect 的一帧量化误差（21ms）。
//
// ⚠️ 拼接点位置是**估算**：aselect 按帧取舍（1024 样本一帧），实际切点与理论值最多差一帧（21ms）。
//   fade 取 40ms 时这点误差仍在窗口内（最坏情况点前 19ms 已衰减 -24dB），听不出阶跃。

const num = (x) => String(Math.round(Number(x) * 1e6) / 1e6);

// ── 音视频对齐（2026-10-31 修）──
// 背景：select/aselect 是**各自按自己的帧网格**取整的。段的时长 d 在视频侧被量化成
//   floor(e/T)-floor(s/T)+[s 落在网格上] 帧、音频侧量化成 ⌈d/1024样本⌉，两边误差各自 ±1 帧。
//   十几段时看不出来（实测 12 段：视频比音频长 19ms）；「收紧气口」会把段数推到 90+，
//   实测同一条素材视频 118.20s / 音频 117.50s —— **累计 0.7s，成片后半段口型对不上**。
// 解法：把段边界吸附到「半帧」位置（离任何帧时刻都 ≥T/4，浮点比较不会再踩边界），
//   改用半开区间 gte*lt（闭区间 between 会两头都算进去、每段多留一帧），
//   并把音频重新打包成 1ms 一帧（50 帧/秒下段长恒为整毫秒，音频帧数也就恒等于段长）。
//   实测 93 段：视频 5867 帧 = 117.340s、音频 117.341s，逐段对齐。
export function snapSegs(segs, fps) {
  const T = 1 / fps;
  // 吸到「所在帧的中点」：幂等（已经是中点的不再移动），且离任何帧时刻都 ≥T/4，浮点比较踩不到边界
  const q = (t) => (Math.floor(t / T) + 0.5) * T;
  const out = [];
  for (const [s, e] of segs) {
    let a = q(s), b = q(e);
    // 相邻两段可能因为各自吸附而重叠 ≤1 帧 → 夹一下，别让同一帧/同一段音频被剪进去两次
    const prev = out[out.length - 1];
    if (prev && a < prev[1]) a = prev[1];
    if (b < a) b = a;
    if (b - a > 1e-6) out.push([+a.toFixed(4), +b.toFixed(4)]);
  }
  return out;
}
/* 切口不许切在字的**语音**中间 —— 剪掉半个音节，声音会断在元音上。
 *
 * 逐字剪把「中点落在切口里」的字画成已删是错的：ASR 把字尾的停顿也算进这个字
 * （实测「吗」0.96s 的 token 只有 0.3s 出声，「啊」0.57s 只出 0.12s），
 * 切口落在字后面的停顿里，中点照样在切口里 → 整个字被画成已删，其实一个字都没剪掉。
 * 所以「有没有剪掉」和「能不能下刀」都只能看语音窗口（voicedWindow），不看 token 中点。
 *
 * 这里只处理**真的被削掉一半以上语音**的字：把剩下的那点语音一起剪干净，
 * 让「听起来」和「稿子上画横线」对上。语音基本还在的字一律不动 ——
 * 那种情况要改的是前端的判定（见 server 的 deadWords），不是把字删掉。
 */
export function trimCutsToVoice(segs, words, env, { ratio = 0.5 } = {}) {
  if (!Array.isArray(segs) || !segs.length || !Array.isArray(words) || !words.length || !env) {
    return { segs, fixed: [] };
  }
  const ws = words
    .filter((w) => w && Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s)
    .sort((a, b) => a.s - b.s);
  const voice = ws.map((w) => voicedWindow(env, w.s, w.e));
  const overlap = (s, e, segsArr) =>
    segsArr.reduce((a, [x, y]) => a + Math.max(0, Math.min(e, y) - Math.max(s, x)), 0);
  const gaps = [[0, segs[0][0]]];
  for (let i = 0; i < segs.length - 1; i++) gaps.push([segs[i][1], segs[i + 1][0]]);
  gaps.push([segs[segs.length - 1][1], env.dur]);
  const fixed = [];
  gaps.forEach((g, gi) => {
    const a0 = g[0], b0 = g[1];
    if (b0 - a0 <= 1e-6) return;
    for (let i = 0; i < ws.length; i++) {
      const v = voice[i];
      if (!v) continue;                                   // 整个 token 就没出声，不存在「剪掉半个字」
      if (ws[i].e <= g[0] || ws[i].s >= g[1]) continue;   // 与这个切口不相交
      const dur = v[1] - v[0];
      if (dur < 0.02) continue;
      const kept = overlap(v[0], v[1], segs);
      if (!(kept > 0.001) || kept >= dur * ratio) continue;   // 已全删 / 语音基本还在
      if (v[0] < g[0] - 1e-6) g[0] = v[0];
      if (v[1] > g[1] + 1e-6) g[1] = v[1];
      fixed.push({ gi, text: ws[i].c, at: +((ws[i].s + ws[i].e) / 2).toFixed(3), kept: +kept.toFixed(3), voice: +dur.toFixed(3) });
    }
    if (g[0] !== a0 || g[1] !== b0) {
      const w = +((a0 - g[0]) + (g[1] - b0)).toFixed(3);
      for (const f of fixed) if (f.gi === gi) f.wound = w;
    }
  });
  const starts = segs.map(([s]) => s);
  const ends = segs.map(([, e]) => e);
  starts[0] = gaps[0][1];
  for (let i = 0; i < segs.length - 1; i++) {
    ends[i] = gaps[i + 1][0];
    starts[i + 1] = gaps[i + 1][1];
  }
  ends[segs.length - 1] = gaps[gaps.length - 1][0];
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    let s = starts[i], e = ends[i];
    const prev = out[out.length - 1];
    if (prev && s < prev[1]) s = prev[1];
    if (e - s > 1e-4) out.push([+s.toFixed(4), +e.toFixed(4)]);
  }
  // 每处收口实际多剪了多少（日志用）：同一切口里的条目共享同一个伤口长度
  return { segs: out, fixed };
}

const AUDIO_UNIT = 48;   // 48000/1000：1ms 一帧，段长（帧网格的整数倍）在音频侧也是整数帧

/**
 * @param {Array<[number,number]>} segs 保留段（原片时间，秒，按时间升序）
 * @param {{speed?:number, fade?:number, fps?:number, env?:object, fades?:number[]}} opts
 *   speed=提速倍数（1=不提速）；
 *   fade=拼接点单侧淡化秒数**上限**（不给按 40ms）；
 *   fps=原片帧率（给了才做帧网格吸附与逐段音视频对齐；不给沿用旧的 between 取整）；
 *   env=10ms 能量包络（edge-snap 产出），给了就按每个拼接点的实际静音余量逐点算 fade
 *   —— 余量足 40ms 更平滑，零余量降到 10ms 只消爆音、不啃字头；
 *   fades=显式指定每点 fade（优先于 env）。
 *
 * ⚠️ 顺序是硬约束：**先 snapSegs 再算 fade**。snap 会把边界移动最多半帧（60fps 下 8.3ms），
 *   若 fade 按吸附前的边界估算、滤镜按吸附后的边界执行，90 段累计下来 afade 的 st 就落错位置，
 *   淡化会盖到字头上 —— 这正是「收紧气口 + 逐字剪」同时开时最容易踩的一脚。
 * @returns {string} filter_complex 文本
 */
export function buildCutFilter(segs, opts = {}) {
  const speed = Number(opts.speed) || 1;
  const baseFade = opts.fade === undefined ? 0.04 : Math.max(0, Number(opts.fade) || 0);
  const fps = Number(opts.fps) || 0;
  const env = opts.env || null;
  const fades = Array.isArray(opts.fades) ? opts.fades : null;
  if (!Array.isArray(segs) || !segs.length) throw new Error("buildCutFilter: segs 为空");
  const list = fps > 0 ? snapSegs(segs, fps) : segs;
  if (!list.length) throw new Error("buildCutFilter: 吸附到帧网格后已无可用段");

  const expr = list.map(([s, e]) => `gte(t,${num(s)})*lt(t,${num(e)})`).join("+");
  const vParts = [`select='${expr}'`, "setpts=N/FRAME_RATE/TB"];
  const aParts = fps > 0
    ? ["aresample=48000", `asetnsamples=n=${AUDIO_UNIT}:p=0`, `aselect='${expr}'`, "asetpts=N/SR/TB"]
    : [`aselect='${expr}'`, "asetpts=N/SR/TB"];

  // 逐点 fade：查静音余量必须用**吸附后**的 list（见函数头注释的硬约束）
  const fadeAt = (i) => {
    if (!fades && baseFade <= 0) return 0;
    if (fades) return Math.max(0, Number(fades[i]) || 0);
    if (env) {
      const room = Math.min(quietBack(env, list[i][1], 0.2), quietFwd(env, list[i + 1][0], 0.2));
      return fadeFor(room, { max: baseFade });
    }
    return baseFade;
  };

  let anyFade = false;
  for (let i = 0; i < list.length - 1; i++) if (fadeAt(i) > 0) { anyFade = true; break; }

  if (anyFade && list.length > 1) {
    // 拼接点在**输出时间轴**上的位置 = 前面各段时长累加；afade 的 st 也是输出时间轴
    // 注意 acc 累加的是 list（吸附后的段长），不是 segs —— 两者差半帧量级，段一多就错位。
    let acc = 0;
    for (let i = 0; i < list.length - 1; i++) {
      acc += list[i][1] - list[i][0];
      const f = fadeAt(i);
      if (f <= 0) continue;
      const a0 = num(acc - f), a1 = num(acc), a2 = num(acc + f);
      const fd = num(f);
      // 淡出：只在前 fade 秒内启用，过了拼接点就直通，避免把后面整段压没
      aParts.push(`afade=t=out:st=${a0}:d=${fd}:curve=cub:enable='between(t,${a0},${a1})'`);
      // 淡入：从拼接点起从 0 升到 1
      aParts.push(`afade=t=in:st=${a1}:d=${fd}:curve=cub:enable='between(t,${a1},${a2})'`);
    }
  }
  if (Math.abs(speed - 1) > 1e-9) {
    vParts.push(`setpts=PTS/${speed}`);
    aParts.push(`atempo=${speed}`);
  }
  return `[0:v]${vParts.join(",")}[vf];[0:a]${aParts.join(",")}[af]`;
}
