// 连续问句链 —— 「同一件事问了两三遍」的确定性识别。
//
// 为什么单独成模块：语义通道只有 ok/slip/paraphrase/offtopic/filler 五个整段标签。
// 同一件事换着措辞问两遍（甚至三遍），每一句单看都通顺、都不属于复述（字面不同），
// 模型一律判 ok；而「删前留后」需要的是"后一句已经问到了，前一句是废的"这种跨句判断。
//
// 实测依据（C0853 53.3–64.4s，四句连问同一件事）：
//   #10「那老师你有什么样的？」              53.34–54.69
//   #11「那老师您这个方法在哪里学呢？」        54.83–56.93
//   #12「你老师到底有什么方法？」              57.83–59.43
//   #13「呃，老师那到底呃呃老师你这个到底是什么方法呢？」 59.63–64.41
// #12 与 #13 焦点同为 METHOD、实词只剩「方法」，是同一问的重说 → 删 #12；
// #11 焦点是 METHOD+WHERE（问"在哪学"），与 #12 不是同一问 → 只标记，交上层进卡片。
// 所以要分两层：焦点集合相等 + 实词高重合 = 同义（可直接删）；焦点不同但共享主题词 =
// 相关（只标记，不删）。后者在 C0820 全片会稳定命中几处"自问自答"式的换角度提问，
// 那些都是要保留的，正好证明只标记不删是必要的。
//
// 本模块只做代码能证明的事：两条都是问句、间隔够近、字面重合够高。不看语义、不猜意图。
// 纯函数：不读环境变量、不读文件，数据全部由调用方传入。
//
// 参数（默认值即实测最优，写在 detectAskChains 的 opt 上）：
//   maxGapSec=2.5  minSharedRatio=0.6  minSharedWords=1  minWords=1  growRatio=2  growSlack=2
// 语料回归（workspace 下 170 个去重后的 raw-segs 全片）：same 共 5 对，全部人工核对为真
//   C0853 #12→#13、qa-midrestart #37→#39/#39→#40/#40→#42（结巴式残句重说）、
//   C0815-talk #0→#1（"我再来一遍啊…"）。C0820（自问自答素材）与 C0777 均为 0。

import { looksLikeAsk } from "./question-cut.mjs";

const PUNCT_RE = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚]/g;

// 只保留汉字，标点/英文/数字一律丢弃（数字不参与比字，避免"30个/10个"这类假重合）
const HAN_RE = /[^\u4e00-\u9fa5]/g;
const norm = (t) => String(t || "").replace(PUNCT_RE, "");

// ---------------------------------------------------------------------------
// 疑问焦点类别：按词表匹配，可多类。
// 顺序无关，但 METHOD 要先于 WHAT 判，否则「什么方法」会被重复计成 WHAT。
// ---------------------------------------------------------------------------
const FOCUS_RULES = [
  // 方法/手段。「怎么学|怎么做|怎么办法|怎么样」也算问方法（C0853 #13 就是"什么方法"）
  ["METHOD", /(方法|办法|方式|招|手段|怎么(?:学|做|办|样)|如何)/],
  ["WHERE", /(哪里|在哪|哪儿|什么地方)/],
  ["WHY", /(为什么|为啥|原因)/],
  ["WHO", /(谁|哪位|什么人)/],
  ["HOWMUCH", /(多少|几个|多久|几天)/],
  ["YESNO", /(是不是|对不对|好不好|行不行|能不能|可不可以|有没有|要不要|吗$)/],
  // 「什么」是最泛的焦点，放在最后；紧跟"方法/办法/方式/招/手段"时归 METHOD，不重复计入
  ["WHAT", /什么(?!方法|办法|方式|招|手段)/],
];

// ---------------------------------------------------------------------------
// 实词剔除表。按"从长到短"拼成一条正则一次性删，避免"这个"只删掉"这"。
// 依据：C0853 #12 剥完只剩「方法」二字，与 #13 剥完的「方法/是」重合 2/2 → 同一问。
// ---------------------------------------------------------------------------
const STOP_SORTED = [
  // 疑问词（含疑问短语，长的排前面）
  "什么地方", "为什么", "什么样", "什么", "怎么样", "怎么", "怎样", "如何", "为啥",
  "在哪里", "哪里", "在哪", "哪儿", "哪位", "谁", "多少人", "多少", "几个", "多久", "几天",
  "是不是", "对不对", "好不好", "行不行", "能不能", "可不可以", "有没有", "要不要",
  // 语气词
  "呃", "啊", "呢", "吧", "嘛", "嗯", "哦", "噢", "唉", "哎",
  // 人称与呼语（"老师"是这批素材里最常见的呼语，必须整词删，否则"老师"两字会撑高重合率）
  "老师", "我", "你", "您",
  // 指示代词 / 副词性虚词
  "这个", "那个", "这么", "那么", "到底", "就", "都", "还", "也",
  // 助词
  "的", "了", "着", "过",
].sort((a, b) => b.length - a.length);
const STOP_RE = new RegExp(STOP_SORTED.join("|"), "g");

/** 疑问焦点类别集合（数组，稳定顺序便于比对与打印） */
export function focusSet(text) {
  const s = norm(text);
  const out = [];
  for (const [name, re] of FOCUS_RULES) if (re.test(s)) out.push(name);
  return out;
}

/** 实词集合：剥掉疑问词/语气词/人称呼语/指示代词/助词后剩下的汉字，按字去重 */
export function contentSet(text) {
  const s = norm(text).replace(STOP_RE, "").replace(HAN_RE, "");
  return Array.from(new Set(s.split("")));
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * 识别连续多个问句问同一件事，给出「删前留后」的候选。
 *
 * @param {Array<{s:number,e:number,z?:string,text?:string}>} units
 *        时间轴片段。z 是原始调用（SEG 数组）的字段名，text 是 cut-audit 的字段名，两者兼容。
 * @param {object} [opt]
 * @param {number} [opt.maxGapSec=2.5]        前句结尾到后句开头的最大间隔（秒）。
 * @param {number} [opt.minSharedRatio=0.6]   实词重合率阈值 = |交| / min(|Wi|,|Wj|)。
 * @param {number} [opt.minSharedWords=1]     实词交集最少字数，低于此值不产出。
 * @param {number} [opt.minWords=1]           两侧实词集合的最少字数（防"啊？""嗯？"这类单字互撞）。
 * @param {number} [opt.growRatio=2]          防自问自答：后句实词量 > 前句 * growRatio + growSlack 时不算重说。
 * @param {number} [opt.growSlack=2]          同上，绝对余量（字）。
 * @param {number} [opt.maxPairs=0]           为 0 不限制；>0 时只保留前 N 对（按时间序）。
 * @returns {{pairs:Array, report:{scanned:number,same:number,related:number,samples:Array}}}
 */
export function detectAskChains(units, opt = {}) {
  const MAXGAP = opt.maxGapSec ?? 2.5;
  const MINRATIO = opt.minSharedRatio ?? 0.6;
  const MINSHARED = opt.minSharedWords ?? 1;
  const MINWORDS = opt.minWords ?? 1;
  const GROWRATIO = opt.growRatio ?? 2;
  const GROWSLACK = opt.growSlack ?? 2;
  const MAXPAIRS = opt.maxPairs ?? 0;

  const arr = Array.isArray(units) ? units : [];
  const textOf = (u) => (u && (u.z != null ? u.z : u.text)) || "";

  // 预计算，避免 O(n²) 里反复剥词
  const info = arr.map((u) => {
    const t = textOf(u);
    return { ask: looksLikeAsk(t), F: focusSet(t), W: contentSet(t), t: norm(t) };
  });

  const pairs = [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i], ia = info[i];
    if (!a || !ia.ask) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j], ib = info[j];
      if (!b) continue;
      // s 单调增：一旦间隔超限，后面的更远，直接断链
      let gap = b.s - a.e;
      if (!(gap <= MAXGAP)) break;
      if (gap < 0) gap = 0;
      if (!ib.ask) continue;
      if (ia.W.length < MINWORDS || ib.W.length < MINWORDS) continue;

      const shared = ia.W.filter((c) => ib.W.includes(c));
      if (shared.length < MINSHARED) continue;

      const denom = Math.min(ia.W.length, ib.W.length);
      const ratio = denom ? shared.length / denom : 0;
      const sameFocus = sameSet(ia.F, ib.F);

      let mode = null;
      if (sameFocus && ratio >= MINRATIO) {
        // 防自问自答的守卫：C0820 #3「什么叫死的记呢」→ #4「死的记就是只会记知识点，
        // 那活的记忆是什么呢」焦点同为 WHAT、重合率 0.67，光看这两个条件会判成"重说"并
        // 删掉 #3——但 #4 其实在解释 #3 的答案，然后另起一问。区别在内容量：#4 的实词
        // 有 10 个而 #3 只有 3 个（翻 3 倍），是"答+新问"；真重说只是把同一问说啰嗦
        // （C0853 #12→#13 只有 3→4 个，含"呃呃/到底"这类口头废话）。
        // 所以重说允许前句更短，但不允许后句实词量翻倍还有余。
        const grown = ib.W.length > ia.W.length * GROWRATIO + GROWSLACK;
        if (!grown) mode = "same";
      } else if (!sameFocus && ratio >= MINRATIO) {
        // 只是同主题、焦点不同 → 只标记，交上层进卡片。
        // 这里也必须过重合率：只看「实词有交集」会把问答体的递进链全打成卡片。
        // 实测飞书 20261028 #5→#6→#7→#9「接下来考什么？／考阅读理解怎么去做啊？／
        // 是瞎做吗？／作文是随便编的吗？」—— 每一问都在推进新信息，相邻句共享的
        // 只有「考／阅读／作文」这种主题词，重合率 0.5；一旦只要求"有交集"就出 6 张废卡。
        // C0853 #11→#12 是同一主题（老师的方法）的两种问法，重合率 1.0，仍能命中。
        mode = "related";
      }
      if (!mode) continue;

      pairs.push({
        i, j, mode,
        fi: ia.F.slice(), fj: ib.F.slice(),
        shared,
        gapSec: +gap.toFixed(2),
        ratio: +ratio.toFixed(2),
        ti: ia.t, tj: ib.t,
      });
      if (MAXPAIRS > 0 && pairs.length >= MAXPAIRS) break;
    }
    if (MAXPAIRS > 0 && pairs.length >= MAXPAIRS) break;
  }

  const same = pairs.filter((p) => p.mode === "same").length;
  return {
    pairs,
    report: {
      scanned: arr.length,
      same,
      related: pairs.length - same,
      samples: pairs.slice(0, 8),
    },
  };
}
