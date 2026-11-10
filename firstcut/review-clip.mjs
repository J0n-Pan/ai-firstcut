// 审核队列与「最终保留段」求交 —— 只留真正还能剪的地方。
//
// 起因：气口检测会先剪掉大段静音（实测 C0793 剪掉 48.3s），而语义裁决拿的是**原片句段**，
// 于是队列里会出现「这句在中段、模型想删」但该时间段早已被气口剪掉的条目。
// 用户点「删除」没有任何效果 —— 这不是"保守"，是假按钮。所以落盘前必须裁掉。
const TOL = 0.12;   // 小于 120ms 的交集不值得操作（听感上也听不出来）

function merge(list) {
  if (!list.length) return [];
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [s[0].slice()];
  for (const [a, b] of s.slice(1)) {
    const last = out[out.length - 1];
    if (a - last[1] <= 0.01) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function clipCuts(cuts, kept) {
  const out = [];
  for (const r of cuts || []) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [s, e] = r;
    for (const [a, b] of kept) {
      const x = Math.max(s, a), y = Math.min(e, b);
      if (y - x > TOL) out.push([+x.toFixed(3), +y.toFixed(3)]);
    }
  }
  return merge(out);
}

// 「待确认」不显示语气词：filler-* 是"模型判删、但句法/留白护栏没把握"的两三个字的垫词，
// 用户既听不出差别也没有判断依据，问了只是把队列撑长、把真正要拍板的整句挤出第一屏。
// 生成端（run.mjs）已不再写入，这里再兜一层：老工程 work/review-queue.json 里的存量条目读出来时同样丢掉。
const HIDDEN_KIND = /^filler-/;

// 返回 { items, dropped }：dropped 是"落在已剪区间、已失效"的条目数
export function clipReviewItems(items, kept) {
  const res = [];
  let dropped = 0;
  let alreadyRemoved = 0;
  for (const it of items || []) {
    if (HIDDEN_KIND.test(String(it.kind || ""))) continue;
    const options = (it.options || []).map((o) => ({
      ...o,
      cuts: clipCuts(o.cuts || [], kept),
    }));
    // 条目区间 = **所有**可删选项并集的范围。
    // 旧写法取「第一个带 cuts 的选项」，在只有一个删除选项时没差别；但 slip-noref 现在是
    // 「只删末尾分句 / 整段删 / 保留」三档，第一档只覆盖末尾 2s，卡片会把 13.0–17.8 的整句
    // 显示成 15.5–17.8，和「整段删」的区间对不上。
    const allCuts = options.flatMap((o) => o.cuts || []);
    if (!allCuts.length) {
      // 这张卡片的每个可删区间都落在「已经被别的通道剪掉」的区域里 —— 气口、低电平整句、
      // 收紧气口的掩膜都在这儿，它们跑得比语义层早，剪完就没人记得这里曾有过一句话。
      //
      // 不能静默丢弃。实测 C0793：模型把 #8「这果免费送价值一千多万就不能说是吧」判成
      // slip-noref 并生成了卡片，气口先把它 97% 的时长当静音剪掉，于是这里 options 全空，
      // 卡片被丢掉 —— 用户看到的是「模型明明标了，界面上却什么都没有」。
      //
      // 改为保留原区间、清空 options（已无可执行的删除项），标 alreadyRemoved 供 UI 灰显。
      // s/e 保持原样：此时再按 kept 求交只会得到空集，反而丢失「这句话原本在哪」。
      res.push({ ...it, alreadyRemoved: true, options: [] });
      alreadyRemoved++;
      continue;
    }
    const s = Math.min(...allCuts.map((c) => c[0]));
    const e = Math.max(...allCuts.map((c) => c[1]));
    res.push({ ...it, s: +s.toFixed(3), e: +e.toFixed(3), options });
  }
  return { items: res, dropped, alreadyRemoved };
}

// ── 决定 → 有效片段表 ──
// 基线计划永远不动（cut-plan.json），决定是叠加在上面的增量。
// 这样反复重剪是幂等的：不会因为上次已经减过而越剪越短。
const EPS = 1e-6;

export function subtract(segs, [a, b]) {
  const out = [];
  for (const [s, e] of segs) {
    if (b <= s + EPS || a >= e - EPS) { out.push([s, e]); continue; }
    if (a > s + EPS) out.push([s, Math.min(a, e)]);
    if (b < e - EPS) out.push([Math.max(b, s), e]);
  }
  return out;
}

export function applyDecisions(segs, decisions) {
  let out = (segs || []).map(([s, e]) => [s, e]);
  for (const d of decisions || []) {
    if (d.choice !== "cut") continue;
    for (const r of d.cuts || []) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const a = Number(r[0]), b = Number(r[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      out = subtract(out, [a, b]);
    }
  }
  return out.filter(([s, e]) => e - s > 0.12).sort((x, y) => x[0] - y[0]);
}
