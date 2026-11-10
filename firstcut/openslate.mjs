// 片头口令 —— 对着镜头外说的话，不是内容。
//
// 为什么单独一层（2026-11-06）：
//   同一类句子，语义通道给的结论不稳定。C0779 首句「你问题先问一下」被判 offtopic 删掉，
//   C0777 首句「那你先问呗」却被判 ok 留在成片第一句 —— 两条素材、同一句话型。
//   而这一类**有确定的结构特征**，根本不需要问模型：
//     · 位置：一定在成片最前面（拍摄开始时那句"准备好了吗"）
//     · 长度：短（口令是插话，不是论述）
//     · 措辞：整句就在说拍摄行为本身，不承载任何内容
//     · 后件：紧跟一句明显更长的正式内容
//
// 判据（全部满足才删）：
//   ① 前 2 个单元之内，且起点 ≤ openMaxAt 秒
//   ② 字数 ≤ maxChars、时长 ≤ maxDurSec
//   ③ 剥掉句首语气词/称呼后，**整句**命中 OPEN_UTTER 里的某个模式
//   ④ 后一单元 ≥ minNextChars 字（确认后面才是正文）
//
// ⚠️ 用整句模式而不是关键词子串。子串版本实测把「是的我准备去给学生上课」判成口令
//    （命中"准备"）—— 那是正经内容，删掉就是误删开场论点。整句匹配后这类不再命中。
// 关闭：XUNJIAN_OPEN_SLATE=off

const PUNCT_G = /[^\u4e00-\u9fffA-Za-z0-9]/g;
const norm = (s) => String(s || "").replace(PUNCT_G, "");
// 句首这些不承载语义（"那你先问呗" / "呃我们开始吧"）
const LEAD = /^(?:那个|这个|那么|那|呃|嗯|啊|哎|诶|欸|哦|噢|好|行|来|就是|我们|咱们|我|你|您)+/;

// 整句 = 拍摄行为。写窄是有意的：宁可漏掉一句口令（人耳一听就知道），
// 也不要把开场第一句正经话删掉（那是整条视频的钩子）。
const OPEN_UTTER = [
  /^问题?先?问(一下|下|吧|呗|嘛|啊)?$/,          // 你问题先问一下 / 那你先问呗
  /^(先|再)?问(一下|下|吧|呗|嘛)$/,
  /^(开始|开始吧|开始了吗|准备一下|准备开始|准备开始吧|来吧|走|走起)$/,
  /^(准备好了吗|准备了吗|好了吗|可以了吗|行了吗|录了吗|开始录了吗)$/,
  /^(听得到吗|听得见吗|听见吗|能听见吗|有声音吗)$/,
  /^(看镜头|看这儿|看这里|对着镜头)$/,
  /^(三二一|一二三|321|三二一走|一二三走)$/,
  /^(再说一遍|重来|重来一遍|再来一遍|再来一次)$/,
];

/**
 * @param units 拆段后的语义单元（每个带 s/e/z）
 * @param opts  { maxAt, maxUnits, maxChars, maxDurSec, minNextChars }
 * @returns {{cuts:number[][], report:object[]}}
 */
export function detectOpenSlate(units, opts = {}) {
  const MAXAT = opts.maxAt ?? 12;
  const MAXU = opts.maxUnits ?? 2;
  const MAXCH = opts.maxChars ?? 12;
  const MAXSEC = opts.maxDurSec ?? 2.6;
  const MINNEXT = opts.minNextChars ?? 10;
  const cuts = [], report = [];
  for (let i = 0; i < Math.min(MAXU, units.length - 1); i++) {
    const u = units[i];
    if (u.s > MAXAT) break;
    const t = norm(u.z);
    if (!t || t.length > MAXCH) continue;
    if (u.e - u.s > MAXSEC) continue;
    const core = t.replace(LEAD, "") || t;
    if (!OPEN_UTTER.some((re) => re.test(core))) continue;
    // 后件判据不能只看**紧邻**那一个单元。C0777「那你先问呗」后面紧跟的是
    // 「是哪个哦」—— 4 个字，其实是 ASR 在静音里幻觉出来的（实测那段 mean −40.8dB，
    // 而正常语音 −13.5dB），它本身也会在气口那一步被丢掉。向后看 3 个单元取最长，
    // 既确认"后面有正文"，又不会被这类残句挡住。
    const look = units.slice(i + 1, i + 4).map((x) => norm(x.z).length);
    if (!look.length || Math.max(...look) < MINNEXT) continue;
    cuts.push([u.s, u.e]);
    report.push({
      s: u.s, e: u.e, cut: t,
      kept: norm(units[i + 1].z).slice(0, 14),
      reason: `片头口令：「${t}」是对镜头外说的拍摄指令（${(u.e - u.s).toFixed(2)}s），后面才是正文`,
    });
  }
  return { cuts, report };
}
