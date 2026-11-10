// 短起头残片 —— 「一句话刚起了个头就被自己打断，紧接着从头说了一遍」。
//
// 形状：一个 ≤5 字 / ≤1.4s 的独立单元，后面 1.5s 内接一个 ≥8 字的单元，
// 而且这个短单元的字**几乎全被后一句的开头覆盖**（"那看到孩" vs "当孩子看到爸爸的脸是这个"）。
// 这类碎片在拆段之前根本看不出来（它藏在 30 字的整段里），拆段之后才成为一个独立单元；
// 语义通道面对它只能判 ok（它确实是后句的前件），结构通道的 LCP 判据又要求≥6 字连续重合，
// 三边都不认领 —— 用户听到的就是成片开头挂着一句断头话。
//   实测 C0777 #7「那看到孩」（0.96s）→「当孩子看到爸爸的脸是这个」；
//   qa-midrestart「你能」→「你能不能通过这个问法」；v13-c3「哪怕是年年」→「哪怕是年龄大了…」。
//
// 判据（全部满足，全库 35 份实测 5 处、无正常语句命中）：
//   ① 单元 ≤ maxChars 字、≤ maxDurSec 秒；
//   ② 后一单元 ≥ minNextChars 字、间隔 ≤ maxGapSec；
//   ③ 本单元的字在后一单元**前 12 字**里的覆盖率 ≥ minCover（"那看到孩" = 3/4）；
//   ④ 不是完整短答/设问/话语标记（对/嗯/好/为什么/然后呢…），也不以「的/了/是/吗/呢/吧」收尾；
//   ⑤ 本单元 ≥ minCutSec 秒（太短的不值得动刀，剪了反而多一个拼接点）。
//
// 关闭：XUNJIAN_HEAD_FRAG=off

const PUNCT_G = /[^\u4e00-\u9fffA-Za-z0-9]/g;
const norm = (s) => String(s || "").replace(PUNCT_G, "");

// 完整短答 / 设问 / 话语标记：它们本来就可以独立成句，后句只是接着往下说
const COMPLETE = /^(对|嗯|哦|噢|好|行|是|没有|可以|是的|对的|好啊|好吧|对啊|是啊|然后|所以|但是|因为|如果|就是|这个|那个|什么|为什么|为啥|多少|几个|第几|你看|他说|我说|你看啊|对不对|是不是)/;

/**
 * @param units 拆段视图 [{s,e,z,srcId,part}]
 * @param opts  { maxChars, maxDurSec, minNextChars, maxGapSec, minCover, minCutSec }
 * @returns { cuts:[[s,e]], report:[{s,e,cut,kept,reason}] }
 */
export function detectHeadFrags(units, opts = {}) {
  const MAXCH = opts.maxChars ?? 5;
  const MAXDUR = opts.maxDurSec ?? 1.4;
  const MINNEXT = opts.minNextChars ?? 8;
  const MAXGAP = opts.maxGapSec ?? 1.5;
  const MINCOVER = opts.minCover ?? 0.75;
  const MINCUT = opts.minCutSec ?? 0.25;
  const WIN = opts.coverWindowChars ?? 12;
  const cuts = [], report = [];
  const U = units || [];
  for (let i = 0; i + 1 < U.length; i++) {
    const u = U[i], nx = U[i + 1];
    const t = norm(u.z);
    if (!t || t.length < 2 || t.length > MAXCH) continue;
    if (u.e - u.s > MAXDUR || u.e - u.s < MINCUT) continue;
    if (nx.s - u.e > MAXGAP) continue;
    const nt = norm(nx.z);
    if (nt.length < MINNEXT) continue;
    if (COMPLETE.test(t)) continue;
    if (/[的了吗呢吧]$/.test(t)) continue;
    const win = nt.slice(0, WIN);
    let hit = 0;
    for (const ch of t) if (win.includes(ch)) hit++;
    if (hit / t.length < MINCOVER) continue;
    cuts.push([u.s, u.e]);
    report.push({
      s: u.s, e: u.e, cut: t, kept: nt.slice(0, 16),
      reason: `短起头残片：「${t}」${(u.e - u.s).toFixed(2)}s，${(nx.s - u.e).toFixed(2)}s 后从「${nt.slice(0, 8)}…」重新起头`,
    });
  }
  return { cuts, report };
}
