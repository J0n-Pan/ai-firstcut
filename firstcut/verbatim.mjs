// 逐字剪：把 ASR 的逐字时间戳整理成「可点的字」，标出水词，并把任意选区换算成**自然切口**。
//
// 与 run.mjs 的关系：这里只读 work/raw-segs.json（ASR 原始产物，剪任何东西都不动它），
// 不跑 ASR、不改剪辑计划。用户删掉的字最终变成一条 {kind:"verbatim", choice:"cut", cuts:[[s,e]]}
// 决定，和审核项走同一条 applyDecisions 减法 —— 所以反复重剪是幂等的。
//
// 2026-11-02：逐字稿改为**对齐工程最新版的剪辑**。
// 以前整篇逐字稿就是 ASR 原文，初剪（气口 + 重说 + 语气词）已经删掉的大段仍然以正常字色
// 躺在页面上 —— 用户看到的字和成片里说出来的字不是一回事，剪的时候只能靠自己回忆
// "这句还在不在"。现在 readDoc 接受 live（最新版保留的原始时间区间），区间外的字标
// live:false；页面**照旧把它们画出来**，只是统一灰掉 + 划横线 ——
// 与用户刚删掉的字一套标记，不必再靠"已剪 10.8s"这种补丁去解释稿子为什么接不上。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapByEnergy } from "./edge-snap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LLM_JS = path.join(HERE, "llm.mjs");

// ── 内置水词表：LLM 不可用时的兜底，也是 LLM 结果的基线 ──
// 收词标准（2026-11-04 修订）：只收「删掉不损失信息」的。
//   语气词只留迟疑音「呃 / 嗯 / 哎 / 唉 / 诶 / 欸」。啊呀嘛呗吧呢哦噢 在口播里是**演绎**
//   （句末语气、情绪收尾、提问腔），删了人物会变生硬，一律不标 —— 词表和 LLM 两条路径都拦。
//   「那」是唯一的单字指示词：只在句首作承接垫词时标（isThatHead 守卫），
//   后接量词/时间词（那个/那时/那里）一律按实指放过。
export const WORDLIST = {
  这个: "k", 那个: "k", 那么: "k", 就是说: "k", 然后: "k", 其实: "k", 反正: "k",
  所以说: "k", 说白了: "k", 你知道吧: "k", 你懂吧: "k", 对吧: "k", 怎么说呢: "k", 这样一个: "k",
  那: "k", 什么的: "k", 之类的: "k",
  // 2026-11-05：这两种在口播里高频起头，删掉不影响信息，但只在「单独起头」时才删
  // （见 isHeadFiller）—— 「就是因为…」「所以今天讲…」是连词，不能碰。
  就是: "k", 所以: "k",
  呃: "y", 嗯: "y",
  // 2026-11-06：哎 / 唉 / 诶 也是句中卡壳的迟疑音（用户反馈「哎」整篇一个都没标）。
  // 只标「后面还接着说」的：句末拖长的「哎——」是演绎，由 isPerformanceTail 拦掉。
  哎: "y", 唉: "y", 诶: "y", 欸: "y",
  // 2026-11-06：句中（非句末）的「啊」是卡壳垫音，用户反馈这些必须能一键删掉。
  啊: "y",
};

/* ── 读逐字稿 ────────────────────────────────────────────────
 * raw-segs.json 有两种形态：[{s,e,z,w:[[s,e,字]]}] 或 {segs:[...]}
 * w 是**逐字**时间戳（不是词）——这是整个功能能成立的前提。
 * 老产物 / 本地 whisper 有时没有 w，就退化成「句子级」，前端会自动切到按句删。
 *
 * live：[原始时间区间] 或 null。给定时把区间外的字标 live:false（见文件头注释）。
 */
export function readDoc(ep, { live = null } = {}) {
  const f = path.join(ep, "work/raw-segs.json");
  if (!fs.existsSync(f)) throw new Error("还没有逐字稿（先跑一轮初剪）");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const segs = Array.isArray(j) ? j : j.segs || [];

  const words = [];
  const paras = [];
  segs.forEach((seg, si) => {
    const w = Array.isArray(seg.w) ? seg.w : null;
    const from = words.length;
    if (w && w.length) {
      for (const [s, e, c] of w) {
        if (!c) continue;
        words.push({ s: +s, e: +e, c, seg: si, live: true });
      }
    } else if (seg.z) {
      // 没有逐字时间戳：把整句按字数均分，保证页面还能用（只是切点精度差一档）
      const chars = [...seg.z];
      const span = (seg.e - seg.s) / Math.max(chars.length, 1);
      chars.forEach((c, i) => words.push({ s: seg.s + span * i, e: seg.s + span * (i + 1), c, seg: si, live: true }));
    }
    paras.push({ i: si, s: +seg.s, e: +seg.e, from, to: words.length - 1, precise: !!(w && w.length) });
  });

  // 去掉空段（ASR 偶尔给空 z）
  const live0 = paras.filter((p) => p.to >= p.from);
  const dur = words.length ? Math.max(...words.map((x) => x.e)) : 0;
  const base = { words, paras: live0, dur: +dur.toFixed(3), precise: paras.every((p) => p.precise) };

  const ranges = normRanges(live);
  if (!ranges) return { ...base, liveDur: base.dur, cutDur: 0, fp: "all" };
  return clipDoc(base, ranges);
}

/* 区间规范化：排序 + 合并相邻。上游（applyDecisions）已经有序，这里只是防御。 */
function normRanges(live) {
  if (!Array.isArray(live) || !live.length) return null;
  const rs = live
    .filter((r) => Array.isArray(r) && r.length === 2 && Number.isFinite(+r[0]) && Number.isFinite(+r[1]) && +r[1] > +r[0])
    .map(([s, e]) => [+s, +e])
    .sort((a, b) => a[0] - b[0]);
  if (!rs.length) return null;
  const out = [rs[0].slice()];
  for (const [a, b] of rs.slice(1)) {
    const last = out[out.length - 1];
    if (a - last[1] <= 0.01) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function inRanges(rs, t) {
  let lo = 0, hi = rs.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < rs[m][0]) hi = m - 1;
    else if (t >= rs[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

/* 短指纹：只用于诊断「这份稿子裁自哪一版区间」，不进缓存 key。
 * 镜头剪掉一段之后字数、首尾都不变，但水词标注**不用重判** —— 标注里存的是原始下标，
 * 剪掉的只是显示，服务端读缓存时把落在已删区间的条目滤掉即可，不必再花一次模型调用。 */
function rangesFp(rs) {
  let h = 0x811c9dc5;
  const s = rs.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${rs.length}.${h.toString(36)}`;
}

/* 把整篇稿子按 live 区间标一遍：
 * 字：区间外的标 live:false（**不删**，下标保持与 raw-segs 一致 —— 前端报上来的
 *     「第几个字到第几个字」、已删清单的上下文摘要、水词缓存都靠这套原始下标）；
 * 段：**保持 ASR 原样**，不再按保留区间重切。页面要把剪掉的字也画出来（灰掉 + 横线），
 *     段一旦切开，被剪的字就无处安放了。
 * liveDur / cutDur 仍按区间算：页头要告诉用户"这一版成片多长、剪掉了多少"。 */
function clipDoc(base, ranges) {
  const t = (w) => (w.s + w.e) / 2;
  const words = base.words.map((w) => ({ ...w, live: inRanges(ranges, t(w)) }));
  const liveDur = ranges.reduce((a, [s, e]) => a + (e - s), 0);
  return {
    ...base, words,
    liveDur: +Math.min(liveDur, base.dur).toFixed(3),
    cutDur: +Math.max(0, base.dur - liveDur).toFixed(3),
    fp: rangesFp(ranges),
  };
}

/* ── 水词判定 ────────────────────────────────────────────────
 * 两步：先用词表把确定的标出来，再让模型补词表抓不到的口头禅（「你知道吧」这类）。
 * 模型只回**短语本身**（不回下标）——回下标要模型数位置，错一位就整段错位；
 * 回短语则在本地按全文匹配，错了最多是多标一处，不会把整篇打乱。
 */
/* 段内字符流 + 「字符 → 字下标」映射。
 *
 * 为什么不能直接 `p.from + text.indexOf(phrase)`：ASR 的 w 里会出现**双字条目**
 * （实测 702 字里有 13 个「一定」「一些」），一个数组元素占两个字符。
 * 于是字符下标比字下标跑得快，段内每遇到一个双字条目，其后所有命中的标记就整体右移一位
 * ——「你看到这个题目」会被标成「[题][目]」，而真正的「这个」一个都没标。
 * 必须按字符流匹配、用 owner 反查字下标。
 */
function charStream(doc, p) {
  const chars = [];
  const owner = [];
  for (let wi = p.from; wi <= p.to; wi++) {
    for (const ch of doc.words[wi].c) { chars.push(ch); owner.push(wi); }
  }
  return { text: chars.join(""), owner };
}

function matchInSegs(doc, phrase, kind) {
  const out = [];
  if (!phrase) return out;
  const n = [...phrase].length;
  for (const p of doc.paras) {
    const { text, owner } = charStream(doc, p);
    let i = 0;
    while ((i = text.indexOf(phrase, i)) !== -1) {
      const a = owner[i], b = owner[i + n - 1];
      if (a !== undefined && b !== undefined && b - a + 1 <= n) out.push({ from: a, to: b, kind, by: "dict" });
      i += n;
    }
  }
  return out;
}

/* 按上下文片段精确定位（LLM 路径）。
 *
 * 原先是「模型报词 → 本地全文匹配」，结果是**一处判对、处处标红**：
 * 模型说「你看到这个题目」里的『这个』是实指不该报，但只要它在别处报了「这个」，
 * 全文每个「这个」都会亮起来。改成模型连上下文一起给，本地只在那一处落标记。
 */
function matchCtx(doc, phrase, ctx) {
  const out = [];
  const n = [...phrase].length;
  for (const p of doc.paras) {
    const { text, owner } = charStream(doc, p);
    let ci = 0;
    while ((ci = text.indexOf(ctx, ci)) !== -1) {
      const ti = text.indexOf(phrase, ci);
      if (ti !== -1 && ti < ci + ctx.length) {
        const a = owner[ti], b = owner[ti + n - 1];
        if (a !== undefined && b !== undefined) out.push({ from: a, to: b, kind: "k", by: "llm" });
      }
      ci += Math.max(1, ctx.length);
    }
  }
  return out;
}

/* 「这个 / 那个」的实指守卫。
 *
 * 这两个词单独看是最高频的口头禅，但「看到这个题目」「这个作文」里它们是**实指**，
 * 直接标出来会让整篇稿子看起来乱七八糟（用户实测反馈的第一条就是这个）。
 * 逐字稿没有标点可依，只能看右邻字：
 *   右邻是语气词（啊/吧/呢/嘛/呀/哦/哎）或同类指示词（这个…那个）→ 填充用法，标；
 *   右邻是实词（题/问/分/人/事/话…）→ 实指，不标。
 * 宁可少标：漏掉一个口头禅只是少捡一次，错标一个实词会让用户不再信任整页标注。
 */
const TAIL_PARTICLE = new Set([..."啊吧呢嘛呀哦噢哎唉嗯呗"]);
// 口播演绎：句末/短语末的语气收尾。不标，也不该被剪掉（用户 2026-11-04 口径）。
const PERFORMANCE_PARTICLE = new Set([..."啊呀嘛呗吧呢哦噢唉哎"]);
// 「那」后接这些字 = 实指（那个/那时/那里/那样…）。含繁体：素材里有繁体转写。
const INDIC_TAIL = new Set([..."个时里边样么些儿天年次种位本张条只件台辆個時裡邊樣麼兒種張條隻臺輛"]);
const PUNCT = /^[，。？！、；：,.?!;:…—～"'“”‘’（）()《》【】]$/;
const TAIL_GAP = 0.22; // 句末换气；低于这个值更像句中卡壳
const HEAD_GAP = 0.12; // 句首起头；低于这个值是连读
// 「这个 / 那个」后面停这么久 = 说话人在想词，是垫词不是定语。
// 阈值比 TAIL_GAP 松一档：句末换气要更明显才算演绎，而垫词后的迟疑常常只有 0.2s。
const HESI_GAP = 0.18;
// 后接另一个水词 → 前一个必然是废话（「这个就是说」「那个然后」）。
// 只放短词：长词连用少见，写全了反而漏判。
const FILLERISH_NEXT = ["就是说", "然后", "其实", "反正", "所以说", "说白了", "对吧", "那么", "怎么说"];

/* 「这个」后面紧跟着的 4 个字（不跨段）—— 判「这个就是说」这种连用。
 * 逐字稿是 token 流不是字符串，跨 token 的词必须自己拼。 */
function nextText(doc, h, n = 4) {
  const w = doc.words[h.to];
  let s = "";
  for (let i = h.to + 1; i < doc.words.length && s.length < n; i++) {
    if (!w || doc.words[i].seg !== w.seg) break;
    s += doc.words[i].c;
  }
  return s;
}

export function isFillerContext(doc, h, word) {
  const w = doc.words[h.to];
  const next = doc.words[h.to + 1];
  if (!next) return true;
  // 段末：这半句在这里就断了，后面没有名词可修饰 —— 是顺嘴的收尾垫词
  if (w && next.seg !== w.seg) return true;
  if (TAIL_PARTICLE.has(next.c)) return true;
  if (/^[这那]/.test(next.c)) return true;
  // 后接停顿：「这个，我跟你说」里的换气点。定语和名词之间不会停这么久，
  // 所以这一条能把大量「这个 + 实词」的场景放进来（2026-11-05 放宽，用户反馈标得太少）。
  if (w && next.s - w.e >= HESI_GAP) return true;
  // 后接另一个水词：「这个就是说」「那个然后」—— 两个垫词连用，第一个必然是废话
  const nt = nextText(doc, h, 4);
  if (FILLERISH_NEXT.some((p) => nt.startsWith(p))) return true;
  // 前一个字是迟疑音：「呃这个」「啊这个」「嗯那个」，明摆着在现想词
  const prev = doc.words[h.from - 1];
  if (prev && w && prev.seg === w.seg && /[呃嗯额啊]$/.test(prev.c) && w.s - prev.e < 0.4) return true;
  // 段首起头：「这个 / 那个」出现在一句话最前面，多数是承接上句的垫词（「这个我们来看」）。
  // 这是实测里漏得最多的一类 —— ASR 的逐字时间戳连着，后接停顿几乎抓不到，只能靠位置判。
  // ⚠️ ASR 的「段」不等于「句」：它经常在一句话中间断开，那种情况 prev 跨段但 gap≈0。
  // 所以段界还要配停顿：gap < 0.3s 说明只是分词断了，仍按句中的严判据走（不标），
  // 否则「你记住的这个题目类型」会被误标成水词。
  // 「那么」不进这条：它最常作程度副词（「那么简单」），删了会改变语义，只靠停顿/后接词判。
  if (!prev || prev.seg !== w.seg) {
    const gap = prev ? w.s - prev.e : 9;
    // 前一个字是疑问/感叹收尾（「…会好吗，这个记忆力好」）时不算起头：那是同一段话里的实指，
    // 只是 ASR 在这口气之后断了句。这类样本实测是段首规则唯一的系统性误标来源。
    const afterTail = prev && /[吗呢吧么嘛]$/.test(prev.c);
    if (word !== "那么" && gap >= 0.3 && !afterTail && !/^[一几两半]/.test(next.c)) return true;
  }
  return false;
}

/* 语气词：段末 / 跨段 / 后接标点 / 后停 ≥0.22s —— 都是句末演绎，不是水词。
 * 机器没有音高，只能靠停顿和段界判断；所以词表本身必须先把演绎词剔掉，
 * 否则「背单词啊」这种后停 0 的短语末语气词，只靠停顿永远抓不出来。
 */
export function isPerformanceTail(doc, h) {
  const w = doc.words[h.to];
  const next = doc.words[h.to + 1];
  if (!w || !next) return true;
  if (next.seg !== w.seg) return true;
  if (PUNCT.test(next.c)) return true;
  return next.s - w.e >= TAIL_GAP;
}

/* 单字「那」：只认句首承接垫词。
 * 「那老师您这个方法」「那到底」「那英语单词…」→ 标；
 * 「那个人」「那时候」「那孩子」→ 实指，放过。
 */
export function isThatHead(doc, h) {
  const w = doc.words[h.from];
  if (!w || w.c !== "那") return false;
  const prev = doc.words[h.from - 1];
  if (prev && prev.seg === w.seg && w.s - prev.e < HEAD_GAP) return false;
  const next = doc.words[h.to + 1];
  if (!next || next.seg !== w.seg) return false;
  if (PUNCT.test(next.c)) return false;
  return !INDIC_TAIL.has(next.c);
}

/* 「就是 / 所以」：只在**单独起头**时算水词。
 * 这两个词本身是连词，删了会破逻辑（「就是因为」「所以今天讲」），
 * 只有「就是…（停一下）我们来看」这种顺嘴起头才是废话。判据只有位置和停顿：
 *   ① 半句在这儿断了；
 *   ② 说完自己也停了一下；
 *   ③ 句首起头且前面有明显的停顿间隔。
 * 后接「说」的交给词表里的「就是说 / 所以说」，不在这里重复标。 */
export function isHeadFiller(doc, h, word) {
  const w = doc.words[h.to];
  const next = doc.words[h.to + 1];
  if (!next) return false;
  if (next.c === "说") return false;              // 就是说 / 所以说 已单独收录
  if (next.seg !== w.seg) return true;
  if (next.s - w.e >= HESI_GAP) return true;
  const prev = doc.words[h.from - 1];
  // 稿子第一句：「就是因为…」是因果连词，不能删；其余起头都按垫词算
  if (!prev) return next.c !== "因";
  const gap = w.s - prev.e;
  // 前面停过一下就是重新起头（「…练习这个，所以我就在小学…」）；
  // 连读的「就是因为」「所以如果」是连词，不动。
  if (gap >= 0.3) return true;
  return false;
}

/* 词表与 LLM 共用的准入判定。
 * 两条路径必须同一套守卫 —— 以前只在词表侧拦「这个/那个」，模型报的照收，
 * 改一边等于没改。
 */
function acceptFiller(doc, h, word, kind) {
  if (kind === "y") return !isPerformanceTail(doc, h);
  if (word === "那") return isThatHead(doc, h);
  if (word === "就是" || word === "所以") return isHeadFiller(doc, h, word);
  if (/^[这那]/.test(word)) return isFillerContext(doc, h, word);
  return true;
}

/* 从模型回报的「片段」里切出真正的水词核。
 *
 * 模型给的是片段（提示词允许 2~6 字，实际常抄成「然后你根据」「考这个」），
 * 直接把片段当标注范围就会把左右邻字一起标成水词 —— 这是用户实测反馈的
 * 「水词两边的字被连带标记」。这里按词表做最长匹配切核，长词优先
 * （「所以说」不会被切成「所以」+「说」），切不出来的片段返回空数组 = 丢弃。
 */
const CORE_WORDS = Object.keys(WORDLIST).sort((a, b) => [...b].length - [...a].length);
export function coreFillers(t) {
  const s = String(t || "");
  const out = [];
  for (let i = 0; i < s.length; ) {
    const w = CORE_WORDS.find((x) => s.startsWith(x, i));
    if (w) { out.push(w); i += [...w].length; continue; }
    i += [...s[i]].length;
  }
  return out;
}

function dictHits(doc) {
  const out = [];
  for (const [word, kind] of Object.entries(WORDLIST)) {
    for (const h of matchInSegs(doc, word, kind)) {
      if (!acceptFiller(doc, h, word, kind)) continue;
      out.push(h);
    }
  }
  return out;
}

function scanWithLlm(doc, { model, apiKey } = {}) {
  const pf = path.join(HERE, "arbiter-prompt-fillerscan.md");
  if (!fs.existsSync(pf)) return { ok: false, why: "缺少 arbiter-prompt-fillerscan.md" };
  // 同一句 ASR 可能被剪成多个 run：拼回去（不加分隔符）才是成片里那句话，模型看到的上下文才完整
  const lines = [];
  let lastI = null;
  for (const p of doc.paras) {
    const t = doc.words.slice(p.from, p.to + 1).map((w) => w.c).join("");
    if (!t) continue;
    if (lastI === p.i && lines.length) lines[lines.length - 1] += t;
    else lines.push(t);
    lastI = p.i;
  }
  const transcript = lines.join("\n");
  const prompt = fs.readFileSync(pf, "utf8").replace("{{INPUT}}", transcript);
  const env = { ...process.env, XUNJIAN_USAGE_TAG: "fillerscan" };
  if (model) env.XUNJIAN_LLM_MODEL = model;
  if (apiKey) env.DASHSCOPE_API_KEY = apiKey;
  const ax = spawnSync(process.execPath, [LLM_JS], { encoding: "utf8", maxBuffer: 32e6, input: prompt, timeout: 180000, env });
  const out = ax.stdout || "";
  if ((ax.status !== 0 && !out.trim()) || !out.trim()) {
    return { ok: false, why: (ax.stderr || ax.error?.message || "无输出").toString().split("\n").slice(-1)[0] };
  }
  try {
    const a = out.indexOf("{"), b = out.lastIndexOf("}");
    const j = JSON.parse(out.slice(a, b + 1));
    const items = (j.items || []).filter((x) => x && typeof x.t === "string" && x.t.trim());
    return { ok: true, items, raw: out.trim().slice(0, 200) };
  } catch {
    return { ok: false, why: "返回不是合法 JSON", raw: out.trim().slice(0, 200) };
  }
}

export function detectFillers(doc, { model, apiKey, useLlm = true } = {}) {
  const hits = dictHits(doc);
  const seen = new Set(hits.map((h) => `${h.from}-${h.to}`));
  let llm = { ok: false, skipped: !useLlm };

  if (useLlm) {
    llm = scanWithLlm(doc, { model, apiKey });
    if (llm.ok) {
      for (const it of llm.items) {
        // 模型报的 t 是「片段」，经常把水词和前后实词一起抄上来
        // （实测：「然后你根据」「考这个」「想一下哎看一下」「和一些这个」）。
        // 拿 t 当标注范围，页面上就会连左右邻字一起染色 —— 用户看到的是
        // 「然后你根据」整段划红线，而且和词表已经标好的「然后」叠成两条。
        // 提示词允许上报的词类全在词表里，所以按词表在 t 里切出真正的水词核；
        // 一个都切不出来 = 模型报的不是水词，丢掉。
        for (const t of coreFillers(String(it.t).trim().slice(0, 16))) {
          const k = WORDLIST[t] === "y" ? "y" : it.k === "y" ? "y" : "k";
          // 演绎类语气词：模型报得再准也不收（词表已把它们移出，这里堵住模型侧的回流）。
          // 例外：哎/唉/诶/欸 在 v6 已改成「句中迟疑音」，句末那种由下面的 isPerformanceTail 拦。
          if (PERFORMANCE_PARTICLE.has(t) && WORDLIST[t] !== "y") continue;
          // 模型偶尔把单字「那 / 这」当成指示代词报上来。单字在中文里绝大多数是实词，
          // 只留「那」——由 isThatHead 判句首垫词；「这」一律不收。
          if (k === "k" && t.length < 2 && t !== "那") continue;
          // 优先按模型给的上下文精确定位到那一处；定位不到（模型抄错原文）且全文只有一处时才兜底。
          const ctx = String(it.ctx || "").trim();
          let found = ctx.includes(t) ? matchCtx(doc, t, ctx) : [];
          if (!found.length) {
            const all = matchInSegs(doc, t, k);
            if (all.length === 1) found = all;
          }
          for (const h of found) {
            if (!acceptFiller(doc, h, t, k)) continue;
            const key = `${h.from}-${h.to}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({ ...h, by: "llm" });
          }
        }
      }
    }
  }

  hits.sort((a, b) => a.from - b.from);
  return { items: hits, llm: { ok: !!llm.ok, why: llm.why || null, skipped: !!llm.skipped } };
}

/* ── 缓存：同一份逐字稿只判定一次 ──
 * key 用「算法版本 + 字数 + 首字起点 + 末字终点」——重跑 ASR 会变，只改剪辑计划不会。
 * 判定逻辑（词表 / 守卫 / 提示词）一变就要升版本号：否则用户点了「逐字剪」拿到的还是
 * 上一版错位的标注，看起来像修复没生效。v3 = 逐字稿只对齐最新版剪辑。
 * v4 = 语气词收窄到「呃/嗯」+ 句末演绎豁免 + 句首「那」（2026-11-04）。
 * v5 = 「这个/那个」放宽：后接停顿、后接另一个垫词、前接迟疑音、段末（2026-11-05）。
 * v6 = 迟疑音扩到「哎/唉/诶/欸」（2026-11-06）。
 * v7 = 模型路径只标水词核，不再把片段里的邻字一起标（2026-11-10）。
 */
export function cacheKey(doc) {
  const w = doc.words;
  if (!w.length) return "empty";
  return `v7:${w.length}:${w[0].s.toFixed(2)}:${w[w.length - 1].e.toFixed(2)}`;
}

export function readCache(ep, doc) {
  const f = path.join(ep, "work/filler-map.json");
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j.key !== cacheKey(doc)) return null;
    return j;
  } catch { return null; }
}

export function writeCache(ep, doc, res, model) {
  const f = path.join(ep, "work/filler-map.json");
  const body = { at: new Date().toISOString(), key: cacheKey(doc), model: model || null,
    llmOk: res.llm.ok, items: res.items };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(body, null, 1));
  return body;
}

/* ── 选区 → 自然切口 ─────────────────────────────────────────
 * v1.3 起改成「时间戳给大致位置、能量包络定最终切点」：
 *   旧做法 `max(prevEnd, first.s - 60ms)` 在 paraformer 的逐字时间戳上是死代码 ——
 *   相邻字的 gap 中位数是 0（509/548 个边界完全首尾相接），max 永远取 prevEnd，
 *   60ms 保护一次都没生效，等于零余量硬切在时间戳上；而时间戳与真实能量谷底
 *   偏差中位 120ms、P90 190ms，切下去 92.7% 落在仍在发声的位置。
 * 现在：传入 env（10ms 能量包络）时，在 t±220ms 内找静音段 / 能量谷底作为切点，
 * 并把「静音余量」带回去给淡入淡出用；没有 env（老调用）时退回旧公式，行为不变。
 */
const PAD = 0.06;
export function snapRange(doc, from, to, env = null) {
  const ws = doc.words;
  const n = ws.length;
  if (!n) return null;
  let a = Math.max(0, Math.min(n - 1, Math.round(from)));
  let b = Math.max(0, Math.min(n - 1, Math.round(to)));
  if (b < a) [a, b] = [b, a];

  const first = ws[a], last = ws[b];
  const prevEnd = a > 0 ? ws[a - 1].e : 0;
  const nextStart = b < n - 1 ? ws[b + 1].s : doc.dur;

  // 起点至少到首字开头、终点至少到末字结尾：吸附只许**往外让**（多借一点静音），
  // 不许往里缩。缩进去就是把要删的字又留了大半 ——「啊 / 呃」这类语气词只有 0.2s，
  // 允许起点后移 150ms 的话，切口只剩 40~60ms，稿子上划了横线、成片里那个字还在。
  let s = Math.max(prevEnd, first.s - PAD);
  let e = Math.min(Math.max(nextStart, last.e), last.e + PAD);
  let room = PAD;

  if (env) {
    // 起点：不许越过上一字的尾音（最多借 20ms），也不许越过首字的开头
    const rs = snapByEnergy(env, s, { win: 0.22, lo: Math.max(prevEnd - 0.02, 0), hi: first.s });
    // 终点：不许越过下一字的起始（最多借 20ms），也不许缩回末字的结尾
    const re = snapByEnergy(env, e, { win: 0.22, lo: last.e, hi: Math.max(nextStart, last.e) + 0.02 });
    const s2 = Math.min(rs.t, first.s);
    const e2 = Math.max(re.t, last.e);
    if (e2 - s2 > 0.02) { s = s2; e = e2; room = Math.min(rs.room, re.room); }
  }

  const p = doc.paras.find((x) => x.i === first.seg);
  if (p && a === p.from) s = Math.min(s, Math.max(0, p.s));
  if (p && b === p.to) e = Math.max(e, p.e);

  s = +s.toFixed(3);
  e = +e.toFixed(3);
  if (!(e > s) || e - s < 0.03) return null;
  return { s, e, room: +room.toFixed(3), chars: b - a + 1, text: ws.slice(a, b + 1).map((w) => w.c).join("") };
}

/* ── 老数据修复：切口只削掉半个字 ─────────────────────────────
 * 旧版 snapRange 允许能量吸附把起点往字里推 150ms。短语气词（啊 0.21s、呃 0.19s）
 * 因此会被压成 40~60ms —— 页面上「已剪」，耳朵里那个字还在，而且因为切口没盖住
 * 字的中心，前端连横线都画不出来，用户想手工补一刀都点不中。
 *
 * 规则：切口**完全落在一个字内部**、又没盖住这个字的大半 → 扩到整字。
 * 只处理 verbatim 决定（审核 / 字幕的切口本来就是句级的，不该被一个字撑开）。
 * 纯函数，读的时候修，不写盘：写盘的事归 /api/decisions，读路径保持无副作用。
 */
export function repairVerbatimCuts(decisions, words) {
  const fixed = [];
  if (!Array.isArray(decisions) || !Array.isArray(words) || !words.length) return { decisions, fixed };
  const out = decisions.map((d) => {
    if (!d || d.kind !== "verbatim" || d.choice !== "cut" || !Array.isArray(d.cuts)) return d;
    let dirty = false;
    const cuts = d.cuts.map((r) => {
      if (!Array.isArray(r) || r.length !== 2) return r;
      const s = +r[0], e = +r[1];
      if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return r;
      // 盖住某个字的中心 = 正常切口（绝大多数情况），不动
      if (words.some((w) => (w.s + w.e) / 2 > s && (w.s + w.e) / 2 < e)) return r;
      // 只压到一个字、又比这个字窄 → 无论压的是字头还是字尾，都是「没把字剪掉」：
      // 典型是被吸附过的 啊 38.78-38.85（字在 38.63-38.79，整段落到了字后面的气口里）。
      // 扩到整字。压到两个字以上就不猜了 —— 那可能是故意剪两字之间的一小段。
      const ov = words.filter((w) => Math.min(e, w.e) - Math.max(s, w.s) > 0.005);
      const w = ov.length === 1 && ov[0].e - ov[0].s > e - s ? ov[0] : null;
      if (!w) return r;
      const to = [+w.s.toFixed(3), +w.e.toFixed(3)];
      dirty = true;
      fixed.push({ text: d.text || "", from: [s, e], to });
      return to;
    });
    return dirty ? { ...d, cuts } : d;
  });
  return { decisions: out, fixed };
}

/* 页面上的「已删」横线该画在哪些字上 —— 判据是**语音**，不是 token 中点。
 *
 * ASR 的逐字时间戳把字尾的停顿也算进这个字：实测「吗」的 token 0.96s 里只有 0.3s 出声，
 * 「啊」0.57s 里只出 0.12s 声。切口落在字后面的停顿里时，token 中点照样在切口里，
 * 按中点判就会把整个字画成已删 —— 但它的语音一个字都没被剪掉，用户一听就发现「标删未删」。
 * 所以：只看这个字的高能量窗口被切掉了多少，≥一半才算真删。
 * token 里完全没有语音的（纯停顿）退回中点判据 —— 那种字标不标都不影响听感。
 *
 * 2026-11-10 修订：比例要按**有声帧计数**算，不能按「首末有声帧的区间长度」算。
 * 「背单|词|啊」的「词」被一句 0.13s 的气口从中间劈开，首末有声帧的区间 = 5.09~5.38，
 * 中间那口气不算语音却也进了分母 —— 保留下来的 0.12s 除以 0.29s 只有 41%，判成「已删」，
 * 逐字稿上就把这个字划掉。按帧算：10 个有声帧里 10 个都在保留段内 → 字活着。
 */
export function deadWordIndexes(words, segs, env, { ratio = 0.5 } = {}) {
  if (!Array.isArray(words) || !Array.isArray(segs)) return null;
  const midIn = (t) => segs.some(([a, b]) => t > a && t < b);
  const step = env?.step || 0.01;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || !(w.e > w.s)) continue;
    const mid = (w.s + w.e) / 2;
    if (!env || !env.db || !env.n) { if (!midIn(mid)) out.push(i); continue; }
    const a = Math.max(0, Math.floor(w.s / step));
    const b = Math.min(env.n, Math.ceil(w.e / step));
    let tot = 0, keep = 0;
    for (let k = a; k < b; k++) {
      if (!(env.db[k] >= env.thr)) continue;
      tot++;
      if (midIn((k + 0.5) * step)) keep++;
    }
    if (!tot) { if (!midIn(mid)) out.push(i); continue; }
    if (keep < tot * ratio) out.push(i);
  }
  return out;
}
