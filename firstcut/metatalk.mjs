// 元话语（meta-talk）与孤立单句 —— 两类「语义通道一定判 ok、但它本来就不该进片」的句子。
//
// 为什么单独成模块：语义通道只有 ok/slip/paraphrase/offtopic/filler 五个整段标签。
// 「单独录这一条」在语义上是一句完整、通顺、语法正确的话（模型只能给 ok），
// 「没关系，我就这样吧」也是一句完整的话（同样 ok）。但它们不是讲给观众听的，
// 是讲给录音键听的 —— 属于"录制说明"，删不删跟内容质量无关，只跟上下文位置有关。
// 与其让模型去猜，不如用代码能证明的条件：位置 + 时长 + 字面无承接 + 命中词表。
//
// ① 片头录制说明（head）
//    实测 DJI_20261022151638_0028 #0「单独录这一条，因为这个比较反反常识嘛。」(0.03–2.86, 2.85s)
//    —— 它是第 0 个原始转写句段（srcId=0），2.85s 就说完，含「单独录」「这一条」，
//    并且和后面 3 句（语文英语、数学就不用背吗、李薇老师…）没有任何实词重合。
// ② 片尾自言自语（tail）
//    实测 20261009_C0793-032028 #10「没关系，我就这样吧。」(84.57–85.67, 1.10s)
//    —— 最后一个句段（srcId=10 = maxSrcId），含「没关系」「就这样吧」，
//    与前 3 句（限时免费送…、感情价值四位数…）实词零交集。
// ③ 孤立单句（isolated）
//    实测同素材 #0「现在备战其中。」(2.56–3.91)，正文主体从 38.46 才开始 ——
//    中间 34.5s 全是静默/试音。它既不是内容，也不属于任何连续语流。
//    反例 C0777 #0「那你先问呗。」(10.58–11.41) 离主体只有 4.5s，属于正常开场对话，
//    用 gap >= 3.0s 会误标 —— 所以把 minGapSec 提到 5.0s（真孤立样本的余量是 34.5s）。
//
// 最终参数（都是 opt 可覆盖的默认值，注释里每组数字都有实测出处）：
//   detectMetaTalk  : maxDurSec 4, neighborSpan 3, minContentChars 2
//   detectIsolated  : bodyGapSec 2.5, minGapSec 5.0, maxIsolatedSec 5.0, minDurSec 0.6
// 调参依据见各函数头注释与文件末尾"实测记录"。
//
// 两类都只「标记」，不负责删（上层做成待确认卡片，由人决定）。
// 同一个下标可能同时出现 meta-talk 与 isolated（片头试录天然也离主体很远），
// 上层按 i 去重即可，建议以 meta-talk 为准。
// 纯函数：无外部依赖、不读文件、不读环境变量。
// 关闭：XUNJIAN_METATALK=off（由上层读取，本模块不碰环境变量）

const PUNCT_RE = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚\[\]【】]/g;
const norm = (t) => String(t || "").replace(PUNCT_RE, "").toLowerCase();

// 实词表用的停用字：语气词 / 人称 / 指示代词 / 助词 / 高频虚词。
// 按「字」去重比较（spec：实词 = 去掉这些之后按字去重的汉字集合），
// 目的是让「单独录这一条因为这个比较反常识」与「语文英语大家都觉得需要记」
// 这类毫不相干的两句一定落到空交集上，而真正的承接（同一话题反复出现）不会被抹掉。
const STOP_CHARS = new Set(
  (
    // 语气词
    "啊呀吧嘛呢吗哦噢嗯呃唉哎哈嘿呗咯嘞哇喔呦哎哟" +
    // 助词 / 结构
    "的地得了着过之所" +
    // 人称
    "我你您他她它咱俺咱俩" +
    // 指示 / 疑问代词
    "这那该此其哪谁什" +
    // 连词 / 副词 / 介词 / 量词 / 高频动词
    "就也都很太还再又才只更最不没别是在有会能要想说要和与跟及或但而却因为所以如果虽然被把让给对从向于上下里中个些一二三四五六七八九十几样么怎何"
  ).split("")
);

/** 取实词字集（按字去重）。只保留汉字，滤掉停用字。 */
function contentChars(text) {
  const set = new Set();
  const s = norm(text);
  for (const ch of s) {
    if (!/[\u4e00-\u9fa5]/.test(ch)) continue;   // 汉字之外（英文缩写、数字）不算实词
    if (STOP_CHARS.has(ch)) continue;
    set.add(ch);
  }
  return set;
}

/** 两句实词交集（返回字符数组，便于 report 里看证据）。 */
function sharedContent(a, b) {
  const out = [];
  for (const ch of a) if (b.has(ch)) out.push(ch);
  return out;
}

// 命中词表：片头 —— 对着录音键说的话
const HEAD_WORDS = ["单独录", "录一条", "录一下", "试一下", "试录", "开始录", "现在开始", "这条", "这一条", "上一条", "重录", "刚才那条", "备战"];
// 命中词表：片尾 —— 收工式自言自语
// 「单独录/录一条」也进片尾词表：C0816 #11「嗯，ok我再单独录一条。」是全片最后一句，
// 它是同一类「讲给录音键听」的试录残留，只是位置在片尾而不是片头。
const TAIL_WORDS = ["就这样", "没关系", "先这样", "行吧", "好吧", "差不多了", "先到这里", "就这样吧",
  "单独录", "录一条", "录一下", "试录"];
// 反向护栏：句子里出现这些内容名词，说明它确实在讲业务，不标（C0816 #0「…数学首先你要记住…」）
const CONTENT_NOUNS = /(成绩|科目|孩子|家长|方法|记忆|学习|英语|语文|数学|分数|考试)/;

/** 句子里命中了哪些词表词（按词表顺序，便于稳定输出）。 */
function matchedWords(text, words) {
  const hits = [];
  for (const w of words) if (text.includes(w)) hits.push(w);
  return hits;
}

/**
 * 片头「录制说明/试录」与片尾「自言自语收尾」识别。
 *
 * 判据（全部满足才命中）：
 *  - 位置：srcId <= 1（片头）或 srcId >= maxSrcId - 1（片尾）；
 *    srcId 缺失时退化为数组下标（raw-segs 直接当 units 用时就是下标）。
 *  - 时长：e - s <= maxDurSec（默认 4s）—— 试录/收尾都是一句话就停，不会长篇。
 *  - 无承接：与前后各 3 个单元的实词交集全为空 —— 它不接任何话头，也不被任何话头接。
 *  - 命中片头/片尾词表之一（按位置只查对应那张表）。
 *  - 反向护栏：句内含内容名词则不标（宁可漏，不可误伤开场正文）。
 *
 * @param {Array<{s:number,e:number,z?:string,text?:string,srcId?:number}>} units
 * @param {{maxDurSec?:number, neighborSpan?:number, minContentChars?:number}} [opt]
 * @returns {{hits:Array<{i:number,kind:"head"|"tail",hits:string[],shared:string[],durSec:number}>,
 *            report:{scanned:number,heads:number,tails:number}}}
 */
export function detectMetaTalk(units, opt = {}) {
  const MAXDUR = opt.maxDurSec ?? 4;
  const SPAN = opt.neighborSpan ?? 3;         // 前后各看 3 个单元
  const MINCONTENT = opt.minContentChars ?? 2; // 实词太少（「嗯」「记住」）不足以判"无承接"，不标
  const list = Array.isArray(units) ? units : [];

  const srcIdOf = (u, i) => (Number.isFinite(u && u.srcId) ? u.srcId : i);
  const ids = list.map(srcIdOf);
  const maxSrcId = ids.length ? Math.max(...ids) : -1;

  const hits = [];
  list.forEach((u, i) => {
    if (!u) return;
    const s = +u.s;
    const e = +u.e;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    const text = String(u.z ?? u.text ?? "");
    const t = norm(text);
    if (!t) return;

    const durSec = e - s;
    if (durSec <= 0 || durSec > MAXDUR) return;

    const id = ids[i];
    let kind = null;
    if (id <= 1) kind = "head";
    else if (id >= maxSrcId - 1) kind = "tail";
    if (!kind) return;

    if (CONTENT_NOUNS.test(t)) return;   // 反向护栏

    const mine = contentChars(t);
    if (mine.size < MINCONTENT) return;  // 纯语气/纯短句，不作为"无承接"证据

    // 无承接：与前后各 SPAN 个单元的实词交集都为空
    const shared = new Set();
    for (let k = Math.max(0, i - SPAN); k <= Math.min(list.length - 1, i + SPAN); k++) {
      if (k === i || !list[k]) continue;
      const other = contentChars(String(list[k].z ?? list[k].text ?? ""));
      for (const ch of sharedContent(mine, other)) shared.add(ch);
    }
    if (shared.size > 0) return;         // 有承接 → 它是正文的一部分

    const words = kind === "head" ? HEAD_WORDS : TAIL_WORDS;
    const mh = matchedWords(t, words);
    if (!mh.length) return;

    hits.push({
      i, kind, hits: mh, shared: [...shared],
      durSec: +durSec.toFixed(2),
      text,
    });
  });

  return {
    hits,
    report: {
      scanned: list.length,
      heads: hits.filter((h) => h.kind === "head").length,
      tails: hits.filter((h) => h.kind === "tail").length,
    },
  };
}

/**
 * 孤立单句识别：离「正文主体」很远、且本身很短的单句。
 *
 * 正文主体的定义：按时间排序后，把「相邻间隔 <= bodyGapSec」的单元串成连续簇，
 * 取总时长（簇内最后一句 e - 第一句 s）最长的那一簇。
 * 实测 C0793：主体 = 38.46–85.67（连续语流），而 2.56–3.91 / 7.29 / 29.88 都在簇外。
 * bodyGapSec 取 2.5 而非 2.0：实测 飞书101141 的 96.99→99.02 只有 2.03s，是一句正常的
 * 换气停顿，用 2.0 会把后半段正文整个切成"片尾孤立句"（#17/#18/#22 三句误标）；
 * 提到 2.5 后该素材 24 句并为一体，孤立句 = 0。
 *
 * 判据（全部满足）：
 *  - 落在主体之外（e < bodyStart 或 s > bodyEnd）；
 *  - 与主体的距离 >= minGapSec（默认 5.0s）。实测 C0777 #0「那你先问呗」(10.58–11.41)
 *    离主体 15.94 只有 4.53s，属于正常开场对话，不是"孤立"；3.0s 会误标，故提到 5.0s。
 *    真孤立样本 C0793 #0 的 gap 是 34.55s，DJI #0 是 10.1s，余量充足。
 *  - 自身时长在 [minDurSec, maxIsolatedSec] 内。低于 0.6s 的多是「嗯。」「记住。」这类
 *    纯语气残句，已由 filler 通道处理，这里不重复标。
 *  - 它自己所在的簇也必须短（簇跨度 <= maxIsolatedSec）。这条是"孤立"的字面意思：
 *    实测 C0777 各版本里 31–36 是一段连续重说（簇跨度约 14s），只是排在主体之后，
 *    若只按"离主体远"判，会一次标出 7 句 —— 那不是孤立句，是第二段正文。
 *
 * 同一侧有多句时全部输出，按 gap 降序（离主体越远越可疑），由上层自己取。
 *
 * @param {Array<{s:number,e:number,z?:string,text?:string}>} units
 * @param {{bodyGapSec?:number, minGapSec?:number, maxIsolatedSec?:number, minDurSec?:number}} [opt]
 * @returns {{hits:Array<{i:number,side:"pre"|"post",gapSec:number,durSec:number,text:string}>,
 *            report:{scanned:number,bodyStart:number|null,bodyEnd:number|null,bodyUnits:number}}}
 */
export function detectIsolated(units, opt = {}) {
  const BODYGAP = opt.bodyGapSec ?? 2.5;
  const MINGAP = opt.minGapSec ?? 5.0;
  const MAXDUR = opt.maxIsolatedSec ?? 5.0;
  const MINDUR = opt.minDurSec ?? 0.6;
  const list = Array.isArray(units) ? units : [];

  // 只保留时间合法的单元参与聚类，但记原下标
  const idx = [];
  list.forEach((u, i) => {
    if (!u) return;
    const s = +u.s;
    const e = +u.e;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
    idx.push({ i, s, e, text: String(u.z ?? u.text ?? "") });
  });
  idx.sort((a, b) => a.s - b.s);

  // 按「相邻间隔 <= BODYGAP」串成簇
  const clusters = [];
  for (const it of idx) {
    const cur = clusters[clusters.length - 1];
    if (cur && it.s - cur[cur.length - 1].e <= BODYGAP) cur.push(it);
    else clusters.push([it]);
  }

  // 总时长最长的簇 = 正文主体
  let body = null;
  let bodySpan = -1;
  for (const c of clusters) {
    const span = c[c.length - 1].e - c[0].s;
    if (span > bodySpan) { bodySpan = span; body = c; }
  }
  if (!body) {
    return { hits: [], report: { scanned: list.length, bodyStart: null, bodyEnd: null, bodyUnits: 0 } };
  }

  // 每个单元所属簇的跨度：用来排除"第二段正文"（簇内连续,只是排在主体之后）
  const clusterSpan = new Map();
  for (const c of clusters) {
    const span = c[c.length - 1].e - c[0].s;
    for (const it of c) clusterSpan.set(it.i, span);
  }

  const bodyStart = body[0].s;
  const bodyEnd = body[body.length - 1].e;
  const inBody = new Set(body.map((x) => x.i));

  const hits = [];
  for (const it of idx) {
    if (inBody.has(it.i)) continue;
    const side = it.e < bodyStart ? "pre" : it.s > bodyEnd ? "post" : null;
    if (!side) continue;
    const gap = side === "pre" ? bodyStart - it.e : it.s - bodyEnd;
    if (gap < MINGAP) continue;
    const dur = it.e - it.s;
    if (dur > MAXDUR || dur < MINDUR) continue;
    if ((clusterSpan.get(it.i) ?? dur) > MAXDUR) continue;  // 属于一段连续语流 → 不是孤立句
    hits.push({
      i: it.i, side, gapSec: +gap.toFixed(2), durSec: +dur.toFixed(2), text: it.text,
    });
  }
  hits.sort((a, b) => b.gapSec - a.gapSec);

  return {
    hits,
    report: {
      scanned: list.length,
      bodyStart: +bodyStart.toFixed(3),
      bodyEnd: +bodyEnd.toFixed(3),
      bodyUnits: body.length,
    },
  };
}

// ─── 实测记录（.qa-metatalk-test.mjs，raw-segs.json 直接当 units 用）────────────
// 正例  ui-DJI_20261022151638_0028：mt=[0:head(单独录/这一条)]  iso=[]   （#1 起 0 命中）
//       —— iso 为空是因为 #0 与 #1 首尾相接（2.86→2.86，间隔 0），属于第一段语流的开头，
//          不是"孤立"；它已由 meta-talk 覆盖。
// 正例  ui-20261009_C0793-032028  ：mt=[0:head(备战) 10:tail(没关系/就这样/就这样吧)]
//                                   iso=[0:pre@34.55]  body=38.46–75.36
//       注意：#0 同时被 head 与 pre 标到（"备战"在片头词表里）。上层按 i 去重。
// 反例  C0777（.qa-split-c0777）/ C0816（.qa-split-c0816）：mt=0 命中
//       C0777 #0「那你先问呗。」gap 4.53s < 5.0 → iso 也不标；
//       C0816 #0「那端的补助是嗯数学吧…」10.46s > 4s 且含内容名词"数学" → 被两道护栏各挡一次。
// 反例  ui-飞书20261028-180650-101141：mt=0  iso=0（bodyGapSec 2.5 时 24 句并为一体）
// 全量  ai-xunjian/episodes 下 99 个含 raw-segs.json 的工程：meta 28 命中 / iso 53 命中，
//       无"同一段连续语流被逐句标出"的连击（该缺陷由 clusterSpan 护栏修掉）。
