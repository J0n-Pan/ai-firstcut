// 问句结构切口 —— 两类「模型看不见、语义标签也没有对应项」的问题。
//
// 为什么单独成模块：语义通道只有 ok/slip/paraphrase/offtopic/filler 五个整段标签，
// 遇到下面两类句子只能判 ok（它们确实是"下一句的前件/最终版"），而三层确定性兜底
// （孤立设问、短残句、分句悬空）要求的是"前后都安静"或"左右都有切口"，也接不住。
//
// ① 半截问句：话停在「什么样的」就断了，0.6s 内重新问一遍。
//    实测 C0853 #10「那老师你有什么样的」（1.35s，53.34–54.69），下一句 54.83 就是
//    「那老师您这个方法在哪里学呢」。模型判 ok 的理由是"它是后面几句的前件"——在语义上
//    没错，但在成片里它就是一句断头话。
// ② 问句前缀卡壳：段内停顿后从称呼重新起头
//    「呃老师那到底‖（停 0.52s）‖呃呃老师你这个到底是什么方法呢」。
//    detectMidRestarts 要求 ≥3 遍起头 + ≥5 字短语复现；这里只有 2 遍 + 「老师」2 字，
//    永远不命中（该素材 inner-restart 候选为 0，inner-restart.json 都没生成）。
//
// 两类都只做代码能证明的事：不看语义、不猜意图，条件全是时长/停顿/字数/字面重合。
// 关闭：XUNJIAN_QUESTION_CUT=off

const PUNCT_RE = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚]/g;
const norm = (t) => String(t || "").replace(PUNCT_RE, "");

const ASK_WORD = /(什么|怎么|怎样|如何|为什么|为啥|哪个|哪里|哪儿|哪位|谁|多少|是不是|对不对|好不好|行不行|能不能|可不可以|要不要|有没有)/;
const TAG_ASK = /(对吧|是吧|好不好|行不行|对不对|可以吗|好吗)$/;

/** 疑问句识别。与 run.mjs 里那份同源（那边在 REDUNDANCY_ON 块内，作用域拿不到），
 *  改判据时两处要一起改。不依赖标点：送模型的文本已被 nrmT 去标点。 */
export function looksLikeAsk(text) {
  const s = norm(text);
  if (s.length < 3) return false;
  if (/(吗|呢)$/.test(s)) return true;
  if (TAG_ASK.test(s)) return true;
  return ASK_WORD.test(s);
}

// 语气词：段首连说时先剥掉再比字面（「呃呃老师」与「呃老师」要能对上）
const LEAD_FILLER = /^[呃嗯啊哦噢唉哎]+/;

/** 半截问句：句末停在「什么样的/怎么样的/哪一种的/哪个的」——缺中心语，话没说完。
 *  必须同时满足「0.6s 内下一句也是问句且更长」，否则可能只是一句短问，不动。 */
export function detectQuestionHeadFrags(segments, opts = {}) {
  const MAXCHARS = opts.headFragMaxChars ?? 12;
  const MAXGAP = opts.headFragMaxGapSec ?? 0.6;
  const DANGLING = /(什么样的|怎么样的|哪一种的|哪个的)$/;
  const out = [];
  (segments || []).forEach((sg, i) => {
    if (!sg) return;
    const t = norm(sg.z);
    if (!t || t.length > MAXCHARS) return;
    if (!DANGLING.test(t)) return;
    const nx = segments[i + 1];
    if (!nx || !nx.z) return;
    const gap = nx.s - sg.e;
    if (gap > MAXGAP) return;
    if (!looksLikeAsk(nx.z)) return;
    const nt = norm(nx.z);
    if (nt.length < t.length + 2) return;     // 下一句必须更长，才叫"重新问了一遍"
    out.push({
      segId: i, s: +sg.s.toFixed(3), e: +sg.e.toFixed(3),
      text: t, nextText: nt, gap: +gap.toFixed(2),
    });
  });
  return out;
}

/** 问句前缀卡壳：段内 ≥pauseSec 停顿之后，从段首的称呼重新起头。
 *  条件（全部满足才切）：
 *   - 整段是问句；
 *   - 停顿前的前缀（剥掉句首语气词）≤ maxHeadChars 字，且**不含疑问焦点**（含则不切，
 *     那可能是真提问被截断，不是废起头）；
 *   - 停顿后的后缀（剥掉语气词）≥ minTailChars 字，且仍是问句；
 *   - 后缀开头与前缀开头连续重合 ≥ minRepeatChars 字（#13：都是「老师」）；
 *   - 切完剩 ≥ minTailSec 秒、切掉 ≤ maxCutSec 秒。
 *  切口从段首起到后缀第一个实字止 —— 中间的「呃呃」一并删掉（它们本来就是卡壳）。 */
export function detectQuestionPrefixRestarts(segments, opts = {}) {
  const PAUSE = opts.prefixPauseSec ?? 0.35;
  const MAXHEAD = opts.prefixMaxHeadChars ?? 8;
  const MINTAIL = opts.prefixMinTailChars ?? 8;
  const MINREP = opts.prefixMinRepeatChars ?? 2;
  const MAXCUT = opts.prefixMaxCutSec ?? 4;
  const MINLEFT = opts.prefixMinTailSec ?? 1.5;
  const out = [];
  (segments || []).forEach((sg, sid) => {
    if (!sg || !Array.isArray(sg.w) || !sg.w.length) return;
    if (!looksLikeAsk(sg.z)) return;
    // 展平成字序列（与 detectMidRestarts 同一套均摊规则）
    const chars = [];
    for (const [ws, we, word] of sg.w) {
      const clean = String(word || "").replace(PUNCT_RE, "");
      if (!clean) continue;
      const n = clean.length;
      let k = 0;
      for (const ch of clean) {
        chars.push({ c: ch, s: ws + (we - ws) * (k / n), e: ws + (we - ws) * ((k + 1) / n) });
        k++;
      }
    }
    if (chars.length < MAXHEAD + MINTAIL) return;
    let best = null;
    for (let k = 1; k < chars.length; k++) {
      if (chars[k].s - chars[k - 1].e < PAUSE) continue;
      const head = chars.slice(0, k);
      const tail = chars.slice(k);
      const headTxt = head.map((x) => x.c).join("");
      const tailTxt = tail.map((x) => x.c).join("");
      const headCore = headTxt.replace(LEAD_FILLER, "");
      const tailCore = tailTxt.replace(LEAD_FILLER, "");
      if (headCore.length < MINREP || headCore.length > MAXHEAD) continue;
      if (tailCore.length < MINTAIL) continue;
      if (ASK_WORD.test(headCore) || /(吗|呢)$/.test(headCore)) continue;  // 前缀里有疑问焦点 → 不是废起头
      if (!looksLikeAsk(tailCore)) continue;
      if (headCore.slice(0, MINREP) !== tailCore.slice(0, MINREP)) continue;
      // 后缀第一个实字的起点：段首的语气词（呃呃）一并切掉
      const lead = tailTxt.length - tailCore.length;
      const cutEnd = tail[lead] ? tail[lead].s : tail[0].s;
      const cutDur = cutEnd - sg.s;
      if (cutDur < 0.2 || cutDur > MAXCUT) continue;
      if (sg.e - cutEnd < MINLEFT) continue;
      if (!best || cutDur > best.cutDur) best = { cutEnd, cutDur, headTxt, tailTxt, headCore, tailCore };
    }
    if (!best) return;
    out.push({
      segId: sid, s: +sg.s.toFixed(3), e: +best.cutEnd.toFixed(3),
      cut: best.headTxt, kept: best.tailCore, reason: `问句前缀卡壳：「${best.headCore}」后停顿，从「${best.tailCore.slice(0, 2)}」重新起头`,
    });
  });
  return out;
}
