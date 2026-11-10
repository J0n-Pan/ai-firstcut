// 剪后残留审计 —— 保证「每一个口播错误要么被删掉、要么被标出来」。
//
// 为什么需要这一层（2026-11-06）：
//   前面所有检测器都是"找得到才动手"：语义通道要模型先判 slip，结构通道要几何条件成立，
//   兜底要左右都有切口。任何一条判据没命中，成片里就安安静静地留着半截话 —— 不报错、
//   不进日志、不进队列，事后和"这段本来就没问题"完全分不出来。这正是用户反复遇到的
//   「漏删」体验：不是删错，是**没有任何人认领**。
//   所以剪完再做一遍**只读**扫描：在最终保留的文本里找"明显还是错的"结构证据，
//   命中就进待确认（默认保留，人一拍板就能删）。它不改变任何已有剪辑结果，
//   只把"没人管"的部分变成"有人管"。
//
// 判据全部是结构性的（不调模型、不看语义），每条都要求能指出具体两个字串：
//   ① 句内重起头：段首 ≤4 字的一截在 4~20 字内原样再现，且再现之后还剩 ≥6 字；
//   ② 跨句尾首相接：前段尾 k 字 == 后段首 k 字（k≥4），两段间隔 ≤1.5s；
//   ③ 半截起头：≤6 字 / ≤1.5s 的短段，后接一个更长段（≤1.2s），且短段与长段有 ≥2 字重合。
//
// 关闭：XUNJIAN_RESIDUAL_AUDIT=off

import { looksLikeAsk } from "./question-cut.mjs";

const PUNCT_G = /[^\u4e00-\u9fffA-Za-z0-9]/g;
const norm = (s) => String(s || "").replace(PUNCT_G, "");
const KEEP_Q = /^(为什么|为啥|咋回事|怎么回事|怎么说|什么意思|然后呢|所以呢|对吧|是吧|多少|几个|第几)/;
const COMPLETE = /^(对|嗯|哦|噢|好|行|是|没有|可以|是的|对的|好啊|好吧|对啊|是啊|然后|所以|但是|因为|如果|就是|这个|那个|什么|为什么|为啥|多少|几个|第几|你看|他说|我说|对不对|是不是|没问题|当然|真的|确实|不行|不是|谢谢|大家好|你好)/;

/** 展平成 [{c,s,e}]：与 segview/retake 同一套均摊规则，用于把字下标换成时间 */
function charsOf(seg) {
  const out = [];
  for (const [ws, we, word] of seg.w || []) {
    const clean = String(word || "").replace(PUNCT_G, "");
    const n = Math.max(1, clean.length);
    let k = 0;
    for (const ch of clean) {
      out.push({ c: ch, s: ws + (we - ws) * (k / n), e: ws + (we - ws) * ((k + 1) / n) });
      k++;
    }
  }
  return out;
}

/** 段落在保留区里的比例（0~1） */
function keptRatio(seg, kept) {
  const dur = Math.max(0.01, seg.e - seg.s);
  let hit = 0;
  for (const [a, b] of kept) {
    const x = Math.max(seg.s, a), y = Math.min(seg.e, b);
    if (y > x) hit += y - x;
  }
  return hit / dur;
}

/**
 * @param units  拆段视图（每个单元带 srcId；未拆段时就是原始句段）
 * @param kept   最终保留区间 [[s,e],...]
 * @param opts   { minHeadRepeat, maxHeadAt, minTailOverlap, shortMaxChars, shortMaxSec }
 * @returns [{ kind, s, e, text, why, cutRange, priority }]
 */
export function auditResiduals(units, kept, opts = {}) {
  const MINHEAD = opts.minHeadRepeat ?? 5;
  const MAXHEADAT = opts.maxHeadAt ?? 20;
  const MINTAIL = opts.minTailOverlap ?? 4;
  const SHORTCH = opts.shortMaxChars ?? 6;
  const SHORTSEC = opts.shortMaxSec ?? 1.5;
  const MAXGAP = opts.maxGapSec ?? 1.2;
  const out = [];
  // 只审「基本完整保留」的单元：被切掉一半的单元，文本与音频已经对不上，审它只会误报。
  // 但相邻关系按**完整单元序列**取 —— 前后句被删掉时，人耳听到的下一句正是后一个保留单元，
  // 中间那段"被删的"不构成听觉间隔（按 live 数组取会把 gap 算成 4s，直接放过）。
  const isLive = units.map((u) => keptRatio(u, kept) >= 0.9 && norm(u.z).length >= 2);

  for (let i = 0; i < units.length; i++) {
    if (!isLive[i]) continue;
    const u = units[i];
    const t = norm(u.z);
    const chars = charsOf(u);
    const at = (k) => (chars[k] ? chars[k].s : u.e);
    // ① 句内重起头
    if (t.length >= 14) {
      // 只认「段首 5~6 字整短语再现」。3~4 字重合在正常口播里到处都是
      // （实测 C0777「孩子的专注，孩子的底气，孩子遇到难题…」是排比，不是重起头），
      // 拿它当证据会把修辞判成口误。
      let hit = null;
      for (let n = Math.min(MINHEAD, t.length - 10); n <= Math.min(6, t.length - 10) && !hit; n++) {
        const head = t.slice(0, n);
        const k = t.indexOf(head, n + 1);
        if (k > 0 && k <= MAXHEADAT && t.length - k - n >= 8) hit = { head, k };
      }
      if (hit && at(hit.k) - u.s >= 0.3 && u.e - at(hit.k) >= 0.8) {
        out.push({
          kind: "residual-restart", priority: 1, s: u.s, e: u.e, text: t.slice(0, 26),
          why: `句内重起头：「${hit.head}」说过一遍，第 ${hit.k + 1} 字起又原样重来`,
          cutRange: [u.s, at(hit.k)],
        });
      }
    }
    // ② 跨句尾首相接
    const nx = units[i + 1];
    if (nx && nx.s - u.e <= 1.5 && !KEEP_Q.test(t)) {
      const a = t, b = norm(nx.z);
      let L = 0;
      for (let k = Math.min(6, a.length, b.length); k >= MINTAIL; k--) {
        if (a.slice(-k) === b.slice(0, k)) { L = k; break; }
      }
      // 前句删掉重合的后缀、保留前文；后句一个字都不动
      if (L && a.length - L >= 4 && chars[a.length - L]) {
        out.push({
          kind: "residual-tail-head", priority: 1, s: u.s, e: nx.e, text: `${a.slice(-10)}｜${b.slice(0, 10)}`,
          why: `跨句尾首重复：前句结尾「${a.slice(-L)}」正是后句开头`,
          cutRange: [chars[a.length - L].s, u.e],
        });
      }
    }
    // ③ 半截起头：短单元的字几乎全被后一句开头覆盖（"那看到孩" → "当孩子看到爸爸的脸是这个"）
    if (t.length >= 2 && t.length <= SHORTCH && u.e - u.s <= SHORTSEC && i < units.length - 1) {
      const nn = units[i + 1];
      const gapA = nn.s - u.e;
      const nt = norm(nn.z);
      const win = nt.slice(0, 12);
      let hit = 0;
      for (const ch of t) if (win.includes(ch)) hit++;
      const cover = hit / t.length;
      if (gapA <= MAXGAP && nt.length >= 8 && cover >= 0.75 &&
          !KEEP_Q.test(t) && !looksLikeAsk(u.z) && !COMPLETE.test(t) && !/[的了吗呢吧]$/.test(t)) {
        out.push({
          kind: "residual-short-head", priority: 2, s: u.s, e: u.e, text: t,
          why: `半截起头：只有 ${t.length} 字 / ${(u.e - u.s).toFixed(2)}s，${gapA.toFixed(2)}s 后从「${nt.slice(0, 12)}…」重新起头`,
          cutRange: [u.s, u.e],
        });
      }
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.kind}@${x.s.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 保留区里实际活下来的字（逐字均摊时间，与切口求交） */
function keptTextOf(u, kept) {
  let out = "";
  for (const ch of charsOf(u)) {
    const mid = (ch.s + ch.e) / 2;
    if (kept.some(([a, b]) => mid >= a - 1e-6 && mid <= b + 1e-6)) out += ch.c;
  }
  return out;
}

/** 覆盖报告：每个单元最终命运（整段删 / 部分删 / 保留 / 有卡片），供验收逐条核对 */
export function coverageReport(units, kept, cuts, cards) {
  const itemAt = (u) => (cards || []).find((c) => c.s < u.e - 0.05 && c.e > u.s + 0.05);
  return units.map((u, i) => {
    const r = keptRatio(u, kept);
    const removed = 1 - r;
    const st = removed >= 0.95 ? "deleted" : removed <= 0.05 ? "kept" : "partial";
    const card = itemAt(u);
    // text 是 ASR 原文，partial 单元里有一半字根本没进成片 —— 只留 text 会让人把
    // 「待删的错话」误读成「成片里还有这句」。必须同时给出 keptText（实际活下来的字）。
    const full = norm(u.z).slice(0, 40);
    const alive = norm(keptTextOf(u, kept)).slice(0, 40);
    return {
      id: i, srcId: u.srcId, part: u.part, s: +u.s.toFixed(2), e: +u.e.toFixed(2),
      text: full, status: st,
      keptText: st === "partial" ? alive : st === "kept" ? full : "",
      card: card ? { kind: card.kind, question: card.question } : null,
    };
  });
}
