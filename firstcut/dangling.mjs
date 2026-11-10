/* ── 分句级「及物动词悬空」检测 ─────────────────────────────────
 *
 * 要解决的问题（实测 ui-李威…040947）：
 *   #6 35.68–49.63「…就像有人能够把圆周率背到小数点后面10万位，
 *                    有人能够在1个小时之内记住几百个。」
 *      末分句「记住」后面只有数量「几百个」，没有中心语 —— 话没说完，
 *      下一句「…能够记住几千接近上万个数字」才把它补全。
 *   #7 50.05–59.92「那有人在1个小时之内能够记住几千接近上万个数字，
 *                    有人能够一遍记住啊，有的人能够在15分钟记住335个单词。」
 *      第 2 分句「记住」后面只有语气词「啊」，同样是悬空，下一分句补全。
 *
 * 为什么整句级检测抓不到：
 *   ASR 的句段是「一口气说完的一整段」（#6 有 71 字 / 14s），错误只占末尾 22 字。
 *   整句相似度被前面 49 字的正确内容稀释到 0.17（阈值 0.6），LCP 只有 1 字，
 *   于是既不像重说、也不像口误，LLM 看整段觉得「总体成立」就标了 ok。
 *   判定粒度必须下沉到**分句**。
 *
 * 判据（两条同时成立，宁漏勿错）：
 *   ① 动词悬空：分句以「及物动词 + (了/着/过) + [数量] + [语气词]」结尾，
 *      且动词前还有主语（排除「记住了。」这种答句残片）；
 *   ② 补全证据：紧邻的下一个分句里出现**同一个动词**，且其后跟着实词宾语。
 *      没有第 ② 条就只是「没说完」，可能是正常的换气断句，不删。
 *
 * 只输出候选，不做删除决定 —— 调用方（run.mjs）负责合并、护栏与落盘。
 */

const PUNCT = /[，。！？；、：…—,.!?;:]/;
const TAIL_PART = /[啊呢吧呀嘛哦噢哎唉嗯呗哈哇哟咯啦喽]+$/;

// 必须带对象才成句的及物动词。刻意保守：不收录「觉得 / 认为 / 说 / 想」这类
// 后面可以直接接小句的动词（「我觉得」「你说」在口播里极其常见，收了会大面积误伤）。
const VTRANS = [
  "记住", "背下", "背诵", "记下", "知道", "看到", "想到", "听到", "说到", "讲到",
  "做到", "拿到", "学到", "得到", "理解", "明白", "掌握", "认识", "发现", "拥有",
  "需要", "包括", "完成", "解决", "提高", "表达", "解释", "指出", "强调", "建议",
  "体会", "感受", "积累", "培养", "改变", "影响", "选择", "决定", "接受", "支持",
  "提供", "证明", "记住",
].sort((a, b) => b.length - a.length);

const VRE = new RegExp(`(${VTRANS.join("|")})(?:了|着|过)?$`);
// 纯数量尾巴：「几百个 / 3 个 / 几千 / 十五分钟」——数量本身不是宾语
const QTY_TAIL = /(?:[0-9０-９]+|[一二两三四五六七八九十百千万亿几多半]+)(?:个|位|次|遍|年|月|天|秒|分|页|条|种|篇|句|字|倍)?$/;

const ALNUM = /[\u4e00-\u9fffA-Za-z0-9]/;
export const norm = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");

/* 按标点切分句，返回 [{text, a, b}]，a/b 是**归一化字符流**里的下标 */
export function splitClauses(z) {
  const out = [];
  let off = 0;
  let cur = "";
  for (const ch of String(z || "")) {
    if (ALNUM.test(ch)) { cur += ch; continue; }
    if (cur) {
      out.push({ text: cur, a: off, b: off + cur.length });
      off += cur.length;
      cur = "";
    }
  }
  if (cur) out.push({ text: cur, a: off, b: off + cur.length });
  return out;
}

/* 每个字的时间戳（取所在词的起点）。paraformer 的 w 可能一个词含多个字。 */
export function charTimes(sg) {
  const ts = [];
  for (const w of sg.w || []) {
    const t = norm(w[2]);
    for (let k = 0; k < t.length; k++) ts.push(w[0]);
  }
  return ts;
}

/* 分句是否以「及物动词 + 数量/语气词」结尾（= 宾语缺失） */
export function danglingOf(text) {
  const t = String(text || "");
  let x = t.replace(TAIL_PART, "");
  const q = x.match(QTY_TAIL);
  if (q) x = x.slice(0, x.length - q[0].length);
  const m = x.match(VRE);
  if (!m) return null;
  const subject = x.slice(0, m.index);
  if (!subject.length) return null;   // 「记住」单独成句 → 多半是答句残片，不判
  const tail = t.slice(x.length);
  // 必须有可见的尾巴（数量或语气词）。只停在动词上的分句不算悬空 ——
  // 反例「考阅读理解」：「理解」是名词宾语「阅读理解」的一部分，「考」才是动词，
  // 这类"动词+名词宾语"的短句在口播里极常见，只看词形分不开，只能要求尾巴作证。
  if (!tail.length) return null;
  return { verb: m[1], subject, tail };
}

/* 顶真（…A，A…）是修辞不是口误：「考阅读理解，阅读理解怎么去做啊」。
 * 判据：本分句结尾 3~8 字正好是下一分句的开头。 */
function tautology(cur, nxt) {
  const a = norm(cur), b = norm(nxt);
  for (let L = Math.min(8, a.length, b.length); L >= 3; L--) {
    if (a.slice(a.length - L) === b.slice(0, L)) return true;
  }
  return false;
}

/* 补全证据：这段文字里出现同一动词，且其后跟着实词（不是又一个数量/语气词） */
export function completes(text, verb) {
  const t = String(text || "");
  const i = t.indexOf(verb);
  if (i < 0) return false;
  let rest = t.slice(i + verb.length).replace(/^[了着过]/, "").replace(TAIL_PART, "");
  if (!rest.length) return false;
  const core = rest.replace(QTY_TAIL, "");
  return norm(core).length >= 1;
}

/**
 * 把一句切成带时间的分句（供前端/队列给「只删这一句」的精确区间用）
 * @returns {Array<{text:string,s:number,e:number}>}
 */
export function clauseRanges(sg) {
  const cls = splitClauses(sg.z);
  const ts = charTimes(sg);
  if (!cls.length || ts.length < cls[cls.length - 1].b) return [];
  return cls.map((c, k) => ({
    text: c.text,
    s: +ts[c.a].toFixed(3),
    e: k + 1 < cls.length ? +ts[cls[k + 1].a].toFixed(3) : +Number(sg.e).toFixed(3),
  }));
}

/**
 * @param {Array<{z:string,s:number,e:number,w:Array}>} rawSegs ASR 句段
 * @param {{minChars?:number, clausesBack?:number, nextGapSec?:number, minClauseSec?:number}} opts
 * @returns {Array<{segId:number, clauseIdx:number, s:number, e:number, text:string,
 *                  verb:string, tail:string, nextText:string, wholeSeg:boolean, tailOfSeg:boolean}>}
 */
export function detectDangling(rawSegs, opts = {}) {
  const o = { minChars: 4, clausesBack: 2, nextGapSec: 2, minClauseSec: 0.5, ...opts };
  const out = [];
  const list = Array.isArray(rawSegs) ? rawSegs : [];

  for (let i = 0; i < list.length; i++) {
    const sg = list[i];
    const cls = splitClauses(sg.z);
    if (!cls.length) continue;
    const ts = charTimes(sg);
    if (ts.length < cls[cls.length - 1].b) continue;   // 逐字时间戳缺失 → 无法换算切口

    // 跨段补全：下一句（间隔不能太远，否则不是"紧接着重说"）
    let nextSegText = "";
    const nx = list[i + 1];
    if (nx && nx.z && nx.s - sg.e <= o.nextGapSec) {
      const nc = splitClauses(nx.z);
      if (nc.length) nextSegText = nc[0].text;
    }

    for (let k = Math.max(0, cls.length - o.clausesBack); k < cls.length; k++) {
      const c = cls[k];
      if (c.text.length < o.minChars) continue;
      const d = danglingOf(c.text);
      if (!d) continue;
      const nxt = k + 1 < cls.length ? cls[k + 1].text : nextSegText;
      if (!nxt || !completes(nxt, d.verb)) continue;
      if (tautology(c.text, nxt)) continue;   // 顶真设问，删了就是把论题词吃掉

      const s = ts[c.a];
      const e = k + 1 < cls.length ? ts[cls[k + 1].a] : sg.e;
      if (!(e - s >= o.minClauseSec)) continue;

      out.push({
        segId: i,
        clauseIdx: k,
        s: +s.toFixed(3),
        e: +e.toFixed(3),
        text: c.text,
        verb: d.verb,
        tail: d.tail,
        nextText: nxt,
        wholeSeg: cls.length === 1,
        tailOfSeg: k === cls.length - 1,
      });
    }
  }
  return out;
}
