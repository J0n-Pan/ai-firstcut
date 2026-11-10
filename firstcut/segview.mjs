// 拆段视图 —— 把「一口气说完的 ASR 句段」按**真实语音停顿**再切成更小的语义单元。
//
// 为什么要这一层（2026-11-06）：
//   paraformer 的 sentences[] 是按语义/标点切句，不是按停顿。于是一个句段里常常塞着
//   「说错的前半 + 重说的后半」或「三遍起头」。语义通道只有整段标签（ok/slip/offtopic），
//   面对这种段只能判 ok（它读起来确实成立），而结构通道的所有判据都要求「重来点贴段首」，
//   于是两边都不认领 —— 成片里就留着半截话。
//   实测 C0777 #7「那看到孩｜当孩子看到爸爸的脸是这个｜当孩子看到爸爸脸是松的…」、
//   C0853 #13「呃老师那到底‖呃呃老师你这个到底是什么方法呢」都是这个形状。
//
// 设计原则（双视图，绝不改原始数据）：
//   · base 视图（rawSegs）保持原样 —— 结构类检测器（段内多次起头、问句前缀、分句悬空、
//     尾首重说、短残句）全部继续吃它，行为零变化；
//   · split 视图（本文件产物）只给**语义通道**用 —— 每个单元带 srcId，判决回落到时间区间，
//     整句级护栏（片头/片尾位置、重来版保护、收尾呼应）仍按 srcId 判定。
//   这样「拆段」不会把任何现有判据的作用对象偷偷换掉，也不会出现"拆完检测器集体失效"。
//
// 切点三证（全部满足才切，宁少切不错切）：
//   ① 词间停顿 ≥ minPauseSec（字级时间戳的真实空隙，不是词时长）；
//   ② 落在**声学静音**里（silencedetect 与剪辑同一噪声门；ASR 时间戳的空隙有时只是
//     对齐误差，实测 34 个候选里 8 个在 ±0.3s 内根本没有静音）；
//   ③ 过中文词边界（Intl.Segmenter，ICU 词典分词；paraformer 的 w 是字级，不能当词表）
//      + 句法护栏（不在「的/了/是/在/和…」后面切，也不在「的/了/吗/呢…」前面切）。
//
// 关闭：XUNJIAN_SPLIT=off（回到旧的单视图行为）

const PUNCT_RE = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚《》【】]/;
const PUNCT_G = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚《》【】]/g;

// 切点两侧的句法护栏：
//   前字是这些 → 后面必然还要接东西（"我的｜孩子" / "放在｜桌子上"），切开就是断句
const NO_SPLIT_AFTER = new Set("的了是在和跟对给把被让使就也还很太更最不没将要会能可以及与或但而且所以因为如果虽然不过".split(""));
//   后字是这些 → 它依附前文（"孩子｜的专注"），切开同样断句
const NO_SPLIT_BEFORE = new Set("的了着过吗呢吧啊呀嘛地得们".split(""));

let SEGMENTER = null;
function wordBounds(text) {
  try {
    if (!SEGMENTER) SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
    const b = new Set([0]);
    let n = 0;
    for (const part of SEGMENTER.segment(text)) { n += part.segment.length; b.add(n); }
    b.add(text.length);
    return b;
  } catch {
    return null;   // 环境没有 ICU 词典 → 跳过词边界校验（仍受句法护栏约束）
  }
}

/** 展平成字序列（与 retake.mjs 的 detectMidRestarts 同一套均摊规则），并保留词下标 */
export function flattenChars(sg) {
  const chars = [];
  const words = [];
  (sg.w || []).forEach(([ws, we, word], wi) => {
    const clean = String(word || "").replace(PUNCT_G, "");
    const n = Math.max(1, clean.length);
    let k = 0;
    for (const ch of clean) {
      chars.push({
        c: ch,
        s: ws + (we - ws) * (k / n),
        e: ws + (we - ws) * ((k + 1) / n),
        wi,
      });
      k++;
    }
    words.push([ws, we, clean]);
  });
  return { chars, words, text: chars.map((x) => x.c).join("") };
}

/**
 * 找出一个句段内部所有合法切点。
 * @returns [{ k, t, gap, why? }]  k = 切在第 k 个字之前（chars[k] 是后半第一个字）
 */
export function splitPointsOf(sg, opts = {}) {
  const MINPAUSE = opts.minPauseSec ?? 0.35;
  const MINHEAD = opts.minHeadChars ?? 3;
  const MINTAIL = opts.minTailChars ?? 3;
  const SIL = opts.silence || null;            // [[ss,se],...] 声学静音
  const SILMIN = opts.minSilenceSec ?? 0.10;
  const USE_WORD = opts.wordBoundary !== false;
  const out = [], rejected = [];
  if (!sg || !Array.isArray(sg.w) || sg.w.length < 4) return { points: out, rejected };
  const { chars, text } = flattenChars(sg);
  if (chars.length < MINHEAD + MINTAIL) return { points: out, rejected };
  const wb = USE_WORD ? wordBounds(text) : null;

  for (let k = MINHEAD; k <= chars.length - MINTAIL; k++) {
    const gap = chars[k].s - chars[k - 1].e;
    if (gap < MINPAUSE) continue;
    const t = chars[k].s;
    const why = [];
    // ② 声学静音
    if (SIL) {
      const hit = SIL.find(([a, b]) => t >= a + 0.015 && t <= b - 0.015 && b - a >= SILMIN);
      if (!hit) why.push("无静音");
    }
    // ③a 词边界
    if (wb && !wb.has(k)) why.push("词内");
    // ③b 句法
    if (NO_SPLIT_AFTER.has(chars[k - 1].c)) why.push(`前字「${chars[k - 1].c}」`);
    if (NO_SPLIT_BEFORE.has(chars[k].c)) why.push(`后字「${chars[k].c}」`);
    if (why.length) { rejected.push({ k, t: +t.toFixed(3), gap: +gap.toFixed(2), why: why.join("+") }); continue; }
    out.push({ k, t: +t.toFixed(3), gap: +gap.toFixed(2) });
  }
  return { points: out, rejected };
}

/**
 * 构建双视图。base 原样返回（调用方本来就有），这里只产出 split 视图。
 * @param rawSegs 原始句段
 * @param opts { minPauseSec, minHeadChars, minTailChars, minSilenceSec, silence, wordBoundary }
 * @returns { units, marks, rejected, baseCount }
 *   units[i] = { s, e, z, w, srcId, part, fromChar, toChar }
 */
export function buildSplitView(rawSegs, opts = {}) {
  const units = [], marks = [], rejected = [];
  (rawSegs || []).forEach((sg, srcId) => {
    const { points, rejected: rej } = splitPointsOf(sg, opts);
    for (const r of rej) rejected.push({ srcId, ...r });
    if (!points.length) {
      units.push({ ...sg, srcId, part: 0, fromChar: 0, toChar: (sg.z || "").length });
      return;
    }
    const { chars } = flattenChars(sg);
    // 同一句段内取「停顿最长」的若干点，但保持顺序；不限制个数（长句可以切成 3~4 段）
    const cuts = points.map((p) => p.k).sort((a, b) => a - b);
    const bounds = [0, ...cuts, chars.length];
    let part = 0;
    for (let p = 0; p < bounds.length - 1; p++) {
      const a = bounds[p], b = bounds[p + 1];
      if (b <= a) continue;
      const head = chars[a], tail = chars[b - 1];
      // 首段用原段起点（含前置静音），末段用原段终点（含尾随静音）—— 与旧行为的切口吸附一致
      const s = p === 0 ? sg.s : head.s;
      const e = p === bounds.length - 2 ? sg.e : tail.e;
      const text = chars.slice(a, b).map((c) => c.c).join("");
      if (!text.trim() || e - s < 0.2) continue;
      units.push({
        s: +s.toFixed(3), e: +e.toFixed(3), z: text,
        // 只保留完全落在本单元内的词，时间原样（不重算，避免二次均摊误差）
        w: (sg.w || []).filter(([, we, word], wi) => {
          const st = chars.find((c) => c.wi === wi);
          return st && st.s >= head.s - 1e-6 && we <= tail.e + 1e-6;
        }),
        srcId, part: part++, fromChar: a, toChar: b,
      });
    }
    for (const p of points) marks.push({ srcId, ...p });
  });
  return { units, marks, rejected, baseCount: (rawSegs || []).length };
}

/** 把「拆后单元区间」裁回原始句段边界：用于必须整句判定的护栏（位置窗/收尾呼应） */
export const inSameSrc = (units, i, j) => units[i] && units[j] && units[i].srcId === units[j].srcId;
