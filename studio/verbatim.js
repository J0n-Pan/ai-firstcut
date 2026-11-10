// 逐字剪 —— 看着逐字稿删水词。
//
// 与审核台的关系：这里只往 overrides.json 里追加 {kind:"verbatim", cuts:[[s,e]]} 决定，
// 和审核项、字幕手剪共用一个 applyDecisions 减法；「应用并重剪」仍走 reexport.mjs。
// 为什么不做成「每删一次立刻重剪」：一次重编码十几秒，逐字改几十处根本没法用。
//
// 四个容易被做错的地方，这里都刻意绕开了：
// ① 选择条固定在面板底部，不做跟随鼠标的浮条 —— 15px 段距里浮条必然压住上下两行字；
// ② 剪掉的字**一律留在原位**（灰掉 + 横线），不隐藏、也不插「已剪 xx 秒」的补丁 ——
//    最新版剪掉的、这次刚删的，用的是同一套标记：横线就是"这里没有了"；
// ③ 切口不在这里算。前端只报「第几个字到第几个字」，由 firstcut/verbatim.mjs 按逐字时间戳
//    换算成对齐停顿的区间，前后端只有一套规则；
// ④ 字的下标是**原始下标**（对应 raw-segs.json），不是渲染后的序号 —— 服务端只给字打
//    live 标记、不重建数组，前后端的「第几个字」才对得上。
// ⑤ 「全选水词」是多段不连续选区，原生 Selection 只有一个 Range，所以批量态自己维护
//    V.sel.ranges，用 class 画高亮；一拖选就退回原生单段。

const V = {
  on: false,
  name: null,
  doc: null,          // { words, paras, dur, precise }
  dead: new Set(),    // 最新版里早已剪掉的字（基线计划未保留），划横线且不可再删
  all: [],            // 全部决定（审核 + 字幕 + 逐字），唯一真源
  fillers: [],        // [{from,to,kind,by}]
  unc: [],            // 模型不确定的句子（从「待确认」迁过来）[{from,to,s,e,reason,...}]
  uncIdx: -1,         // 当前停在第几处待定
  sel: null,          // {from,to} 连续选区 | {ranges:[[from,to]], bulk:true} 批量选区
  pick: null,         // 右侧「已删」里点住的那一条 {id,s,e}：正文同步高亮
  find: "",
  filter: "all",
  following: true,
  busy: false,
  raf: null,
  // 打开/切换工程的序号。逐字稿和水词是两次请求，切换工程时上一次的可能还在飞；
  // 回来时代号对不上就整份丢掉 —— 否则旧素材的稿子会覆盖新素材的页面（字数、下标全错位）
  seq: 0,
  previewTo: 0,       // 删除后试听区间的终点
};

const VB_TAG = { k: "口头禅", y: "语气词" };
// 待确认卡片的类型 → 逐字剪顶部提示里用的短语
const UNC_KIND = {
  "offtopic-mid": "中段疑似跑题",
  "echo-tail": "收尾疑似呼应",
  "slip-noread": "疑似口误",
  "slip-noref": "疑似口误 · 找不到该留的那句",
  "paraphrase-dir": "疑似换说法 · 位置对不上",
  "paraphrase-short": "疑似半句重说",
  "dep-keep": "疑似断了后文前件",
  "logic-link": "疑似断了逻辑衔接",
  "batch-over": "整批超出保护线",
};
const t2 = (t) => {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, "0")}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
};

/* ── 打开 / 关闭 ─────────────────────────────────────────── */

async function openVerbatim() {
  if (!S.name) return toast("先选一条素材", true);
  if (!S.tl) {
    try { await loadTimeline(); } catch (e) { return toast(e.message, true); }
  }
  V.on = true;
  V.name = S.name;
  // 每次打开都换一代：上一次打开时发出的逐字稿/水词请求即便晚回来也不再被采纳
  const seq = ++V.seq;
  V.all = (S.tl?.decisions || []).slice();
  // 历史重复/重叠的 verbatim 决定先并掉，否则「已删」里会出现几条一模一样的条目。
  // 这一步会改真源，必须落盘，不然下次打开又长回来。
  if (normalizeVerbatimDecisions()) saveDecisions().catch(() => {});
  V.sel = null;
  V.pick = null;
  V.previewTo = 0;    // 上一条素材试听没播完就关掉时，别把「播到这儿停」带到新工程
  V.find = "";
  $("vFind").value = "";
  setFilter("all");
  document.querySelector(".main").classList.add("vopen");
  document.body.classList.add("vopen");
  $("vpage").hidden = false;
  $("btnVerbatim").classList.add("on");
  $("vSub").textContent = prettyName(S.name);
  $("vStat").classList.remove("scan");
  $("vStatTxt").textContent = "正在读逐字稿…";
  $("vdoc").innerHTML = `<div class="vloading">正在读逐字稿…</div>`;
  $("vSel").hidden = true;

  await loadVerbatim(false);
  if (seq !== V.seq) return;   // 读稿期间又切了工程：这份不再属于当前页面
  paintDoc();
  paintDeleted();
  paintStats();
  paintDelList();
  paintTimeline();
  attachVideo();
  hideUncBar();
  // 从「待确认」卡片点「到逐字剪选字删」过来时，直接把那一句选中并播上下文 —— 少让用户再找一遍
  focusFromReview();
  // 水词判定要调一次模型，单独打一枪：先把页面给用户看，标点回来了再描上去
  detectFillersLater(seq);
}

function focusFromReview() {
  const f = S.verbatimFocus;
  S.verbatimFocus = null;
  if (!f) return;
  const u = V.unc.find((x) => x.id === f.id) || V.unc.find((x) => Math.abs(x.s - f.s) < 0.35);
  if (!u) return toast("这句在逐字稿里找不到对应位置", true);
  // 选中和说明条不等播放器：视频还没就绪也要先把「哪一句、为什么」摆到眼前
  focusUncertain(u, true);
}

function closeVerbatim() {
  if (!V.on) return;
  V.on = false;
  V.seq++;   // 作废在飞的逐字稿/水词请求：关掉页面之后回来的响应一律不要
  document.querySelector(".main").classList.remove("vopen");
  document.body.classList.remove("vopen");
  $("vpage").hidden = true;
  $("btnVerbatim").classList.remove("on");
  hideUncBar();
  stopFollow();
  const v = $("vVideo");
  v.pause();
  v.removeAttribute("src");
  v.load();
  syncVPlay();
  // 回审核台时主播放器可能刚被换过源（成片/原片），图标跟着它自己的状态重画一次
  if (typeof syncPlayBtn === "function") syncPlayBtn();
  // 回审核台后按最新决定重画一遍（逐字删的区间也要反映在时间轴上）
  if (S.name) loadTimeline().catch(() => {});
}

/* ── 数据 ────────────────────────────────────────────────── */

async function loadVerbatim(detect = false, seq = V.seq) {
  const q = `name=${encodeURIComponent(V.name)}${detect ? "&detect=1" : ""}`;
  const r = await api(`/api/verbatim?${q}`);
  // 请求发出后工程被换掉：这份稿子属于上一条素材，写进 V 就会让页面上的字和工程对不上
  if (seq !== V.seq) return r;
  if (!r.ok) throw new Error(r.error || "读不到逐字稿");
  V.doc = {
    words: r.words, paras: r.paras, dur: r.rawDur, precise: r.precise,
    liveDur: r.liveDur, cutDur: r.cutDur, ver: r.ver,
  };
  buildDead();
  buildUncertain();
  if (detect) V.fillers = r.fillers || [];
  else V.fillers = r.fillers || [];
  paintSub();
  return r;
}

/* 模型不确定的句子 —— 数据源就是「待确认」队列（S.tl.review），这里只做时间→字下标的换算。
 * 三个刻意的取舍：
 * ① 整句早就被初剪剪掉的（字全在死区）不标：标了也删不动，只是多一个点不动的标记；
 * ② 不改 S.review 的结构、也不写决定 —— 待确认那边只展示，判断动作全在这里发生；
 * ③ 换算是「与句子时间区间有交集」，不是「字的下标区间」，因为 ASR 切句和逐字时间戳不是一套边界。 */
function buildUncertain() {
  const ws = V.doc?.words || [];
  const review = (S.tl?.review || []);
  const out = [];
  for (const it of review) {
    const s = +it.s, e = +it.e;
    if (!(e > s)) continue;
    let from = -1, to = -1;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (w.e <= s || w.s >= e) continue;
      if (from < 0) from = i;
      to = i;
    }
    if (from < 0) continue;
    let alive = 0;
    for (let k = from; k <= to; k++) if (!V.dead.has(k)) alive++;
    if (!alive) continue;
    out.push({
      id: it.id, s, e, from, to,
      kind: it.kind || "",
      text: it.text || "",
      reason: it.llm?.reason || "",
      guard: it.guard?.rule || "",
    });
  }
  V.unc = out.sort((a, b) => a.s - b.s);
  V.uncIdx = -1;
}

/* 页头只留一句：这一版成片多长。剪掉多少不在这里重复 ——
 * 稿子里的横线和右下角「已删」已经说清了，三处各写一遍，数字还容易对不上。 */
function paintSub(keep) {
  if (!V.doc) return;
  const live = keep != null ? keep : (V.doc.liveDur ?? V.doc.dur);
  const raw = V.doc.dur && Math.abs(V.doc.dur - live) > 0.5 ? ` / 原片 ${t2(V.doc.dur)}` : "";
  $("vSub").textContent = `${prettyName(V.name)} · 最新版${V.doc.ver ? " v" + V.doc.ver : ""} 成片 ${t2(live)}${raw}`;
}

/* 最新版里早已剪掉的字：**基线计划**（初剪）就没保留的区间。
 * 决定只能从基线里再减、加不回来，所以落在基线外的字永远回不到成片 —— 用 baseSegs 判断即可。
 * 不要用接口回来的 live 标记：那是「读稿那一刻」的快照，撤销一条删除之后就过期了，
 * 字会一直挂着横线、再也去不掉。
 *
 * 判据优先用服务端的 deadWords（按**语音**算：token 里的高能量窗口被切掉一半才算删）。
 * 退回中点判据只在服务端算不出来时用 —— ASR 把字尾停顿算进字里，中点判据会把
 * 「只剪掉了字后面的停顿」误画成「这个字删了」，成片里却一个字都没少（用户报的「标删未删」）。 */
function buildDead() {
  const ws = V.doc?.words || [];
  const base = S.tl?.baseSegs;
  if (!base || !base.length) { V.dead = new Set(); return; }
  const exact = S.tl?.deadWords;
  if (Array.isArray(exact) && exact.length <= ws.length) { V.dead = new Set(exact); return; }
  const set = new Set();
  ws.forEach((w, i) => {
    const mid = (w.s + w.e) / 2;
    if (!base.some(([a, b]) => mid > a && mid < b)) set.add(i);
  });
  V.dead = set;
}

async function detectFillersLater(seq = V.seq) {
  if (seq !== V.seq) return;
  $("vStat").classList.add("scan");
  $("vStatTxt").textContent = "正在标水词…";
  try {
    const r = await loadVerbatim(true, seq);
    if (seq !== V.seq) return;   // 标水词要调模型，等回来时用户可能已经切走了
    V.fillers = r.fillers || [];
    paintDoc();
    paintStats();
    if (r.detect?.ran) {
      toast(`标出 ${V.fillers.length} 处水词${r.detect.llmOk ? "" : "（模型没连上，只用了内置词表）"}`);
    }
  } catch (e) {
    if (seq === V.seq) toast("水词标注失败：" + e.message, true);
  } finally {
    if (seq === V.seq) {
      $("vStat").classList.remove("scan");
      paintStats();
    }
    // 水词标注是唯一在逐字剪里花钱的动作（调一次模型、按 filler-map 缓存只判一次），
    // 服务端已把这一笔记进 fillerscan-usage.json —— 回来就把总花费刷新，别让用户以为这里免费。
    try { if (typeof loadCost === "function") await loadCost(); } catch { /* 记账坏了不影响标注 */ }
  }
}

/* ── 渲染逐字稿 ───────────────────────────────────────────── */

// 字 → 所属水词；用于「点一下选中整个水词」
// 只用**整条都还在**的水词：半条被剪掉的（拖选时剪到了其中几个字）和服务端一样整条不算数，
// 否则再点它会选中已经删掉的字，白多一条空操作
function fillerAt(idx) {
  for (const f of liveFillers()) if (idx >= f.from && idx <= f.to) return f;
  return null;
}

function liveFillers() {
  const gone = deletedSet().set;
  return (V.fillers || []).filter((f) => {
    for (let k = f.from; k <= f.to; k++) if (V.dead.has(k) || gone.has(k)) return false;
    return true;
  });
}

/* 这个切口是否「切掉了这个字」：盖住字的中点（正常情况），或者压掉这个字的一半以上。
 * 只按中点判断的话，比字还窄的切口（老数据里被能量吸附削成 40~60ms 的语气词）
 * 一个横线都画不出来 —— 用户既看不出这个字已经剪了，也点不住它去补一刀。 */
function cutHits(w, s, e) {
  const mid = (w.s + w.e) / 2;
  if (mid > s && mid < e) return true;
  const ov = Math.min(e, w.e) - Math.max(s, w.s);
  return ov > 0 && ov >= (w.e - w.s) * 0.5;
}

function deletedSet() {
  const set = new Set();
  const ws = V.doc?.words || [];
  const cuts = [];
  for (const d of V.all) {
    if (!d || d.choice !== "cut") continue;
    for (const r of d.cuts || []) if (Array.isArray(r) && r.length === 2) cuts.push(r);
  }
  for (const [s, e] of cuts) {
    for (let i = 0; i < ws.length; i++) {
      // 切口会向两边各吃 60ms，纯按端点判断会把邻居字也标成已删，所以看覆盖比例
      if (cutHits(ws[i], s, e)) set.add(i);
    }
  }
  return { set, cuts };
}

// 这个字是不是已经不在成片里了：基线剪掉的（dead）或决定里删掉的
function isCut(i) {
  return V.dead.has(i) || deletedSet().set.has(i);
}

function paintDoc() {
  const d = V.doc;
  if (!d) return;
  // 重画会换掉所有节点，原生选区随之作废。但「水词标注回来了」也会触发重画，
  // 那时把用户手上的选区清掉最恼人 —— 所以按原下标记下来，画完再挂回去。
  const keep = isBulk() ? null : (V.sel ? { from: V.sel.from, to: V.sel.to } : null);
  const box = $("vdoc");
  const frag = document.createDocumentFragment();
  for (const p of d.paras) {
    const el = document.createElement("div");
    el.className = "vp";
    el.dataset.p = p.i;
    const pt = document.createElement("span");
    pt.className = "pt";
    // 时间戳用 ASR 原段的起点；这一段被剪过时，开头的字会带着横线
    pt.textContent = t2(p.s);
    const para = document.createElement("p");
    for (let k = p.from; k <= p.to; k++) {
      const w = d.words[k];
      if (!w) continue;
      const sp = document.createElement("span");
      // dead = 最新版里早就剪掉的。它和这次刚删的 .del 共用一套横线样式，
      // 但标记自绘制起就带着 —— 撤销一条删除不该把基线剪掉的字也「还原」。
      sp.className = "w" + (V.dead.has(k) ? " dead" : "");
      sp.dataset.i = k;
      sp.textContent = w.c;
      para.appendChild(sp);
    }
    el.appendChild(pt);
    el.appendChild(para);
    frag.appendChild(el);
  }
  box.replaceChildren(frag);
  markFillers();
  paintDeleted();   // 里面会顺带重画「待定句子」的底色
  paintBulkSel();
  paintPick();      // 重画会把字节点全换掉，右侧点住的那一条要重新挂回高亮
  applyFind();
  if (keep && restoreNativeSel(keep)) V.sel = keep;
  else V.sel = null;
  paintSelBar();
}

// 把 {from,to} 重新挂成原生选区（重画之后调用）
function restoreNativeSel({ from, to }) {
  const box = $("vdoc");
  const a = box.querySelector(`.w[data-i="${from}"]`);
  const b = box.querySelector(`.w[data-i="${to}"]`);
  if (!a || !b) return false;
  const r = document.createRange();
  r.setStartBefore(a);
  r.setEndAfter(b);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  return true;
}

// 模型不确定的句子：整句的字染一层浅琥珀（和「水词」的琥珀下划线区分开：这里是底色）。
// 随「已删」一起重画：删掉的那部分不该还带着「这句要不要删」的底色 —— 那是已经拍过的板。
function paintUnc() {
  const box = $("vdoc");
  if (!box) return;
  box.querySelectorAll(".w.unc").forEach((el) => el.classList.remove("unc"));
  if (!V.unc.length) return paintUncStat();
  const { set } = deletedSet();
  for (const u of V.unc) {
    for (let k = u.from; k <= u.to; k++) {
      if (set.has(k) || V.dead.has(k)) continue;
      const el = box.querySelector(`.w[data-i="${k}"]`);
      if (el) el.classList.add("unc");
    }
  }
  paintUncStat();
}

// 这个字落在哪一处待定句子里（点它 = 选中整句 + 播上下文）
function uncAt(idx) {
  for (const u of V.unc) if (idx >= u.from && idx <= u.to) return u;
  return null;
}

function markFillers() {
  const box = $("vdoc");
  if (!box) return;
  for (const f of V.fillers) {
    for (let k = f.from; k <= f.to; k++) {
      const el = box.querySelector(`.w[data-i="${k}"]`);
      if (el) el.classList.add(f.kind === "y" ? "fy" : "fk");
    }
  }
}

function paintDeleted() {
  const box = $("vdoc");
  if (!box) return;
  const { set } = deletedSet();
  box.querySelectorAll(".w.del").forEach((el) => el.classList.remove("del"));
  for (const i of set) {
    const el = box.querySelector(`.w[data-i="${i}"]`);
    if (el) el.classList.add("del");
  }
  paintUnc();
}

function paintStats() {
  const all = V.fillers.length;
  const fl = liveFillers();
  const n = { all: fl.length, k: 0, y: 0 };
  for (const f of fl) n[f.kind === "y" ? "y" : "k"]++;
  $("cAll").textContent = n.all;
  $("cK").textContent = n.k;
  $("cY").textContent = n.y;
  $("vStatTxt").innerHTML = n.all
    ? (n.all === all ? `识别到 <b>${n.all}</b> 处水词` : `还剩 <b>${n.all}</b> / ${all} 处水词`)
    : (all ? "水词都剪掉了" : (V.doc?.precise ? "没有发现水词" : "这份逐字稿没有逐字时间戳"));
  const pick = $("vPick");
  if (pick) {
    pick.disabled = !n.all;
    pick.title = n.all ? `一键选中剩下的 ${n.all} 处水词与语气词，再按 Del 一起删掉` : "没有可剪的水词了";
  }
  paintUncStat();
}

// 「待定 N」入口：模型不确定的句子数，点了逐个跳过去
function paintUncStat() {
  const b = $("vNext"), c = $("cUnc");
  if (!b) return;
  const n = V.unc.length;
  if (c) c.textContent = n;
  b.disabled = !n;
  b.title = n ? `跳到下一处模型不确定的句子（共 ${n} 处，点整句会自动播上下文）` : "没有模型不确定的句子";
  // 状态行里只说有水词时那句话，待定数量由按钮自己报，不重复写第二遍
}

/* ── 模型不确定的句子：选中 + 播上下文 ───────────────────── */

// 元数据到手了才动播放器：代理视频可能还在转码，readyState 0 时设 currentTime 会被丢掉
function whenMeta(fn) {
  const v = $("vVideo");
  if (!v) return;
  if (v.readyState >= 1) return fn();
  v.addEventListener("loadedmetadata", fn, { once: true });
}

// 播放 a-b 前后各 margin 秒；和「删完试听」共用一套逻辑，只是边界不同
function playContext(a, b, pre = 1.5, post = 1.5) {
  const v = $("vVideo");
  if (!v || !v.src) return;
  whenMeta(() => {
    seek(Math.max(0, a - pre));
    V.previewTo = Math.min(v.duration || 1e9, b + post);
    v.play().catch(() => {});
    $("vPlay").classList.remove("paused");
  });
}

// 选中整句：想整句删就按 Del，想只删半句就在这基础上继续拖选（拖选会覆盖成更小的范围）
function focusUncertain(u, play = true) {
  if (!u) return;
  V.uncIdx = V.unc.indexOf(u);
  showUncBar(u);
  const box = $("vdoc");
  const a = box.querySelector(`.w[data-i="${u.from}"]`);
  const b = box.querySelector(`.w[data-i="${u.to}"]`);
  if (a && b) {
    const r = document.createRange();
    r.setStartBefore(a);
    r.setEndAfter(b);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    V.sel = { from: u.from, to: u.to };
    paintBulkSel();
    paintSelBar();
    a.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (play) playContext(u.s, u.e);
}

function showUncBar(u) {
  const bar = $("vUncBar");
  if (!bar) return;
  if (!u) { bar.hidden = true; return; }
  const tag = UNC_KIND[u.kind] || "模型不确定";
  const why = u.reason ? `：${u.reason}` : "";
  $("vUncTxt").textContent = `${tag}${why}${u.guard ? `（护栏：${u.guard}）` : ""}`;
  bar.hidden = false;
}

function hideUncBar() {
  const bar = $("vUncBar");
  if (bar) bar.hidden = true;
  V.uncIdx = -1;
}

function nextUncertain() {
  if (!V.unc.length) return toast("模型没有不确定的句子", true);
  V.uncIdx = (V.uncIdx + 1) % V.unc.length;
  focusUncertain(V.unc[V.uncIdx], true);
}

function applyFind() {
  const box = $("vdoc");
  if (!box) return;
  box.querySelectorAll(".w.hit").forEach((el) => el.classList.remove("hit"));
  const q = V.find.trim();
  if (!q || !V.doc) return;
  // 整篇都在页面上（剪掉的字划横线），所以整篇都可搜 —— 搜不到会让人以为字丢了。
  // 逐字时间戳里混着双字条目（「一定」「一些」），字符位置 ≠ 字下标，必须带映射。
  const ws = V.doc.words;
  let text = "";
  const owner = [];
  for (let i = 0; i < ws.length; i++) {
    for (const ch of ws[i].c) { text += ch; owner.push(i); }
  }
  let i = 0;
  let hit = 0;
  while ((i = text.indexOf(q, i)) !== -1 && hit < 400) {
    const ids = new Set();
    for (let k = i; k < i + q.length; k++) if (owner[k] !== undefined) ids.add(owner[k]);
    for (const id of ids) box.querySelector(`.w[data-i="${id}"]`)?.classList.add("hit");
    i += q.length;
    hit++;
  }
  const first = box.querySelector(".w.hit");
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}

function setFilter(f) {
  V.filter = f;
  document.querySelectorAll(".dbar .chip").forEach((b) => b.classList.toggle("on", b.dataset.f === f));
  const page = $("vpage");
  // fk-only = 只留口头禅（把语气词降成普通字色）。以前这两个赋值写反了：
  // 点「语气词」加的是 fk-only，正好把语气词自己压掉 —— 于是「点口头禅看得见、
  // 点语气词全没了」，看着像标注丢了。
  page.classList.toggle("fk-only", f === "k");
  page.classList.toggle("fy-only", f === "y");
}

/* ── 选择 ────────────────────────────────────────────────── */
// 两种选区：原生单段（拖选 / 点水词）与批量（「全选水词」，几十处不连续）。
// 批量态不能用原生 Selection（只有一个 Range），所以自己维护 ranges + class 高亮。
const selRanges = (s = V.sel) => (!s ? [] : s.ranges ? s.ranges : [[s.from, s.to]]);
const isBulk = () => !!(V.sel && V.sel.bulk);

function currentSel() {
  const s = window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  const box = $("vdoc");
  if (!box.contains(r.commonAncestorContainer)) return null;
  let from = -1, to = -1;
  for (const el of box.querySelectorAll(".w")) {
    if (!r.intersectsNode(el)) continue;
    const i = +el.dataset.i;
    if (from < 0) from = i;
    to = i;
  }
  if (from < 0 || to < 0) return null;
  if (to < from) [from, to] = [to, from];
  return { from, to };
}

function paintSelBar() {
  const bar = $("vSel");
  if (!V.sel) { bar.hidden = true; $("vPick").classList.remove("on"); return; }
  const rs = selRanges();
  const ws = V.doc.words;
  let chars = 0, secs = 0;
  for (const [f, t] of rs) {
    if (!ws[f] || !ws[t]) continue;
    secs += Math.max(0, ws[t].e - ws[f].s);
    chars += t - f + 1;
  }
  const bulk = rs.length > 1;
  $("vSelLead").textContent = bulk ? `已选 ${rs.length} 处 · ${chars} 个字` : `已选 ${chars} 个字`;
  $("vSelDur").innerHTML = bulk
    ? `<b>${secs.toFixed(2)}s</b> · 分 ${rs.length} 段剪掉`
    : `<b>${secs.toFixed(2)}s</b> · ${t2(ws[rs[0][0]].s)} – ${t2(ws[rs[0][1]].e)}`;
  $("vSelGo").innerHTML = bulk ? `删除这 ${rs.length} 处<kbd>Del</kbd>` : `删除这段<kbd>Del</kbd>`;
  $("vPick").classList.toggle("on", !!V.sel.bulk);
  bar.hidden = false;
}

// 批量选区高亮：一次几十处，逐字加 class
function paintBulkSel() {
  const box = $("vdoc");
  if (!box) return;
  box.querySelectorAll(".w.swsel").forEach((el) => el.classList.remove("swsel"));
  if (!isBulk()) return;
  const hit = new Set();
  for (const [f, t] of V.sel.ranges) for (let k = f; k <= t; k++) hit.add(k);
  for (const el of box.querySelectorAll(".w")) if (hit.has(+el.dataset.i)) el.classList.add("swsel");
}

function syncSel() {
  if (isBulk()) {
    // 批量态下原生选区是空的；用户一旦自己拖出选区，就退出批量态，按单段处理
    const cur = window.getSelection();
    if (!cur || cur.isCollapsed) return;
    V.sel = null;
    paintBulkSel();
  }
  const s = currentSel();
  const changed = (!s && V.sel) || (s && V.sel && (s.from !== V.sel.from || s.to !== V.sel.to)) || (s && !V.sel);
  V.sel = s;
  // 开始拖选就是换了个话题：上一次点住的「已删」条目让位，别和选区高亮叠在一起
  if (s && V.pick) { V.pick = null; paintPick(); }
  if (changed) paintSelBar();
}

function clearSel() {
  V.sel = null;
  paintBulkSel();
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  paintSelBar();
  hideUncBar();
}

// 点水词 = 选中整个水词（不是立刻删）。先看见选了什么，再决定按不按删除
function selectToken(f) {
  const box = $("vdoc");
  const a = box.querySelector(`.w[data-i="${f.from}"]`);
  const b = box.querySelector(`.w[data-i="${f.to}"]`);
  if (!a || !b) return;
  const r = document.createRange();
  r.setStartBefore(a);
  r.setEndAfter(b);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  V.sel = { from: f.from, to: f.to };
  paintBulkSel();
  paintSelBar();
}

/* 一键选中所有水词 + 语气词。
 * 只选**还没删过**的：已经剪掉的再删一次是空操作，右侧还会多出一列无效条目。
 * 挨着的词（「那个」+「啊」）并成一段，少一次切口；中间隔着实词的不并。 */
function selectAllFillers() {
  if (!V.doc) return;
  if (isBulk()) return clearSel();      // 再点一次 = 取消
  const fl = liveFillers();
  if (!fl.length) return toast(V.fillers.length ? "水词都删掉了" : "还没识别到水词", true);
  const raw = fl.map((f) => [f.from, f.to]).sort((a, b) => a[0] - b[0]);
  const ranges = [raw[0].slice()];
  for (const [f, t] of raw.slice(1)) {
    const last = ranges[ranges.length - 1];
    if (f - last[1] <= 1) last[1] = Math.max(last[1], t);
    else ranges.push([f, t]);
  }
  V.sel = { ranges, bulk: true };
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  paintBulkSel();
  paintSelBar();
  toast(`已选中 ${ranges.length} 处水词，按 Del 一次删掉`);
}

/* ── 批量删除前的确认 ──────────────────────────────────────
 * 「全选水词 → Del」是这里唯一一条一按就改几十处的路径，改的还是「决定」而不是成片：
 * 用户很容易按完就以为定稿了。弹窗只做两件事 —— 说清删了多少、以及删完必须去「已删」逐条审。
 * 返回 Promise<boolean>：true = 确认删除。 */
let bulkAsk = null;
function closeBulkAsk(ok) {
  const m = $("bulkModal");
  if (!m || m.hidden) return;
  m.hidden = true;
  const fn = bulkAsk;
  bulkAsk = null;
  if (fn) fn(!!ok);
}
function askBulkDelete(ranges) {
  const n = (ranges || []).length;
  if (!n) return Promise.resolve(true);
  $("bulkN").textContent = String(n);
  $("bulkGo").onclick = () => closeBulkAsk(true);
  $("bulkCancel").onclick = () => closeBulkAsk(false);
  $("bulkClose").onclick = () => closeBulkAsk(false);
  $("bulkModal").onclick = (e) => { if (e.target === $("bulkModal")) closeBulkAsk(false); };
  $("bulkModal").hidden = false;
  $("bulkGo").focus();
  return new Promise((resolve) => { bulkAsk = resolve; });
}

/* ── 删除 / 撤销 ──────────────────────────────────────────── */

/* 逐字剪的删除必须和「已删」一一对应 —— 一段字只能有一条记录。
 * 以前每次删除都直接 push，于是同一段「其实」删三次就有三条一模一样的条目。
 * 这里把新切口按时间重叠并进现有清单，三条规则：
 * ① 不重叠 → 新增一条；
 * ② 新切口被某条已有删除完整包住 → 跳过（本来就已经删了）；
 * ③ 部分重叠 → 取并集并成一条，旧条目撤掉。并集可能又压到旁边一条，所以反复吸收到不再相交。 */
function absorbCuts(list) {
  const at = new Date().toISOString();
  const added = [];
  let skipped = 0;
  for (const cut of list) {
    let s = +cut.s, e = +cut.e;
    if (!(e > s)) continue;
    const hits = overlappingCuts(s, e);
    if (!hits.length) { added.push(pushCut(s, e, at)); continue; }
    if (hits.some((h) => s >= h.s - 0.005 && e <= h.e + 0.005)) { skipped++; continue; }
    const drop = new Set();
    for (;;) {
      const more = overlappingCuts(s, e, drop);
      if (!more.length) break;
      for (const h of more) { drop.add(h.id); s = Math.min(s, h.s); e = Math.max(e, h.e); }
    }
    V.all = V.all.filter((d) => !drop.has(d.id));
    added.push(pushCut(s, e, at));
  }
  return { added, skipped };
}

function pushCut(s, e, at) {
  const item = {
    id: `vb-${Date.now()}-${Math.round(s * 1000)}-${Math.round(e * 1000)}`,
    kind: "verbatim",
    choice: "cut",
    cuts: [[s, e]],
    text: textOf(s, e),
    at,
  };
  V.all.push(item);
  return item;
}

// 与 [s,e) 有时间交集的 verbatim 切口；skip 里的决定不再算（并集循环里用）
function overlappingCuts(s, e, skip) {
  const out = [];
  for (const d of V.all) {
    if (!d || d.kind !== "verbatim" || d.choice !== "cut") continue;
    if (skip && skip.has(d.id)) continue;
    for (const r of d.cuts || []) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const os = +r[0], oe = +r[1];
      if (!(oe > os)) continue;
      if (Math.min(e, oe) - Math.max(s, os) > 0.005) out.push({ id: d.id, s: os, e: oe });
    }
  }
  return out;
}

// 区间里被切掉的字（清单摘要、决定文本都用它，避免存下来的 text 过时）
function textOf(s, e) {
  return (V.doc?.words || []).filter((w) => cutHits(w, s, e)).map((w) => w.c).join("");
}

/* 打开逐字剪时先把历史上已经重复/重叠的条目并掉，只留一条。
 * 只处理「一条决定一个切口」的形态（本页写出来的都是这种），其它形态不动，免得误删。 */
function normalizeVerbatimDecisions() {
  const items = [];
  for (const d of V.all) {
    if (!d || d.kind !== "verbatim" || d.choice !== "cut") continue;
    if (!Array.isArray(d.cuts) || d.cuts.length !== 1) continue;
    const r = d.cuts[0] || [];
    const s = +r[0], e = +r[1];
    if (!(e > s)) continue;
    items.push({ id: d.id, s, e });
  }
  if (items.length < 2) return false;
  items.sort((a, b) => a.s - b.s);
  const groups = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && it.s < g.e - 0.005) { g.e = Math.max(g.e, it.e); g.ids.push(it.id); }
    else groups.push({ s: it.s, e: it.e, ids: [it.id] });
  }
  const dupe = groups.filter((g) => g.ids.length > 1);
  if (!dupe.length) return false;
  const drop = new Set(dupe.flatMap((g) => g.ids));
  V.all = V.all.filter((d) => !drop.has(d.id));
  for (const g of dupe) {
    V.all.push({
      id: `vb-merge-${Date.now()}-${Math.round(g.s * 1000)}`,
      kind: "verbatim",
      choice: "cut",
      cuts: [[g.s, g.e]],
      // 此刻稿子可能还没读回来，摘要由 snippet() 从字里现算，这里不存文本
      text: "",
      at: new Date().toISOString(),
    });
  }
  return true;
}

async function deleteSel() {
  if (!V.sel || V.busy) return;
  const ranges = selRanges();
  // 「全选水词」一按就删几十处，是逐字剪里唯一一处批量改动。
  // 机器标的水词一定有误标（实指、并列、承接都可能被标），所以先拦一次：
  // 让用户知道删了不等于定稿，也提醒他删完回右侧「已删」逐条过。
  // 单点水词 / 拖选不拦 —— 那是自己看见什么点什么，弹窗只会变噪音。
  if (V.sel.bulk && !(await askBulkDelete(ranges))) return;
  V.busy = true;
  $("vSelGo").disabled = true;
  try {
    // 一次请求把所有选区换算成切口：能量包络只加载一次，几十处也不会卡
    const r = await postJSON("/api/verbatim/cut", { name: V.name, ranges });
    if (!r.ok) { toast(r.error || "这段删不了", true); return; }
    const cuts = r.cuts || (r.cut ? [r.cut] : []);
    if (!cuts.length) { toast("这段太短，删了听不出来", true); return; }
    // 一处删除一条决定，但同一段字只留一条：吃掉被包住的旧条目，部分重叠的并成一条
    const res = absorbCuts(cuts);
    if (!res.added.length) {
      clearSel();
      toast("这段已经删过了，不用再删一次（要改先撤销右侧那条）", true);
      return;
    }
    await saveDecisions();
    clearSel();
    dropStalePick();
    paintDeleted();
    paintDelList();
    paintTimeline();
    paintStats();
    if (res.added.length === 1) {
      // 立刻回放切口前后 2 秒 —— 让耳朵确认拼接处是干净的，而不是等重剪完才发现
      previewAround(res.added[0]);
    } else {
      const secs = res.added.reduce((a, c) => a + (c.cuts[0][1] - c.cuts[0][0]), 0);
      toast(`已删 ${res.added.length} 处 · ${secs.toFixed(1)}s`);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    V.busy = false;
    $("vSelGo").disabled = false;
  }
}

async function undoLast(id) {
  const before = V.all.length;
  if (id) V.all = V.all.filter((d) => d.id !== id);
  else {
    for (let i = V.all.length - 1; i >= 0; i--) {
      if (V.all[i] && V.all[i].kind === "verbatim") { V.all.splice(i, 1); break; }
    }
  }
  if (V.all.length === before) return toast("没有可撤销的删除", true);
  await saveDecisions();
  // 撤销的可能正是右侧点住的那一条（或者被合并掉的那条），高亮跟着失效
  dropStalePick();
  // 不用重读稿子：横线只由「基线剪掉的（dead）+ 决定里的 cuts（del）」两个来源算出来，
  // 撤销掉决定里的那一条，paintDeleted 就会把这几个字的横线去掉。
  paintDeleted();
  paintDelList();
  paintTimeline();
  paintStats();
}

async function saveDecisions() {
  await postJSON("/api/decisions", { name: V.name, decisions: V.all });
  // 审核台那边也拿同一份真源，否则它点「应用并重剪」会把这些决定冲掉
  if (S.tl) S.tl.decisions = V.all.slice();
}

/* 点住的那条被撤销 / 被合并掉之后，别在正文里留一块谁也解释不了的高亮 */
function dropStalePick() {
  if (!V.pick) return;
  if (V.all.some((d) => d && d.id === V.pick.id)) return;
  V.pick = null;
}

/* ── 右侧：已删清单 ───────────────────────────────────────── */

function verbatimCuts() {
  const out = [];
  for (const d of V.all) {
    if (!d || d.kind !== "verbatim" || d.choice !== "cut") continue;
    for (const r of d.cuts || []) if (Array.isArray(r) && r.length === 2) out.push({ id: d.id, s: r[0], e: r[1], text: d.text || "" });
  }
  return out.sort((a, b) => a.s - b.s);
}

// 这段到底还有没有东西可剪：落在「气口早已剪掉的静音」里的删除是空操作。
// 不区分的话，列表会报 3.4s 而时间轴只少 3.0s，用户会以为有 bug。
function effective(s, e) {
  let x = 0;
  for (const [a, b] of S.tl?.baseSegs || [[0, V.doc?.dur || 0]]) {
    x += Math.max(0, Math.min(e, b) - Math.max(s, a));
  }
  return x;
}

function paintDelList() {
  const cuts = verbatimCuts().map((c) => ({ ...c, eff: effective(c.s, c.e) }));
  const sum = cuts.reduce((a, c) => a + c.eff, 0);
  const dur = V.doc?.dur || 1;
  $("vDelCnt").textContent = `${cuts.length} 段 · ${sum.toFixed(1)}s`;
  $("vDelPct").textContent = sum > 0.01 ? `−${((sum / dur) * 100).toFixed(1)}%` : "";
  const box = $("vDelList");
  if (!cuts.length) {
    box.innerHTML = `<div class="dempty">还没有删任何东西<br/>拖选文字，或点「全选水词」</div>`;
    return;
  }
  box.innerHTML = cuts
    .map((c) => `<div class="di${c.eff < 0.05 ? " noop" : ""}" data-id="${esc(c.id)}">
      <span class="r">${t2(c.s)} – ${t2(c.e)}${c.eff < 0.05 ? " · 已剪" : ""}</span>
      <span class="t">${snippet(c.s, c.e)}</span>
      <button class="x" data-undo="${esc(c.id)}" title="撤销这一段">撤销</button>
    </div>`)
    .join("");
  paintPick();
}

/* 点住「已删」里的一条 → 正文同步高亮这几个字。
 * 和播放高亮（.now）、选区（.swsel）分开一个 class：三种高亮会同时存在，
 * 共用一套样式的话，取消选中就分不清哪层该退掉。 */
function paintPick() {
  const box = $("vdoc");
  if (box) {
    box.querySelectorAll(".w.pick").forEach((el) => el.classList.remove("pick"));
    if (V.pick && V.doc) {
      (V.doc.words || []).forEach((w, i) => {
        if (!cutHits(w, V.pick.s, V.pick.e)) return;
        box.querySelector(`.w[data-i="${i}"]`)?.classList.add("pick");
      });
    }
  }
  const list = $("vDelList");
  if (list) {
    list.querySelectorAll(".di").forEach((el) =>
      el.classList.toggle("on", !!V.pick && el.dataset.id === V.pick.id));
  }
}

// 用「切口附近实际的字」做摘要，而不是用决定里存的 text —— 后者可能在多次编辑后过时。
// 只显示被删的字会是一列孤零零的「这个」「啊」，认不出上下文；所以前后各带 5 个字，删掉的染红。
function snippet(s, e) {
  const ws = V.doc?.words || [];
  let hit = ws.filter((w) => cutHits(w, s, e));
  if (!hit.length) {
    // 切口落在字与字之间：没有字被删，只少了一口气。以前这里一律写「（已剪片段）」，
    // 而真正原因是切口太窄、压根没盖住任何字 —— 用户看到的就是「已剪 0.1s + 已剪片段」。
    const ov = ws.filter((w) => Math.min(e, w.e) - Math.max(s, w.s) > 0.01);
    if (!ov.length) return `<span class="ctx">（气口 · ${(e - s).toFixed(2)}s）</span>`;
    hit = ov;
  }
  const i0 = ws.indexOf(hit[0]);
  const i1 = i0 + hit.length - 1;
  const pre = ws.slice(Math.max(0, i0 - 5), i0).map((w) => w.c).join("");
  const post = ws.slice(i1 + 1, i1 + 6).map((w) => w.c).join("");
  return `<span class="ctx">${pre ? "…" + esc(pre) : ""}</span><b>${esc(hit.map((w) => w.c).join(""))}</b><span class="ctx">${post ? esc(post) : ""}…</span>`;
}

/* ── 底部时间轴 ───────────────────────────────────────────── */

function paintTimeline() {
  const tl = $("vTl");
  if (!tl || !V.doc) return;
  const dur = V.doc.dur || 1;
  const base = (S.tl?.baseSegs || [[0, dur]]).map(([a, b]) => [a, b]);
  // 和 reexport 一样：从基线里减掉所有决定，剩下的空隙就是真实被删掉的区间
  const cuts = [];
  for (const d of V.all) {
    if (!d || d.choice !== "cut") continue;
    for (const r of d.cuts || []) if (Array.isArray(r) && r.length === 2) cuts.push([+r[0], +r[1]]);
  }
  const removed = [];
  for (const [a, b] of cuts) {
    for (const [s, e] of base) {
      const x = Math.max(a, s), y = Math.min(b, e);
      if (y - x > 0.05) removed.push([x, y]);
    }
  }
  tl.querySelectorAll(".cut").forEach((n) => n.remove());
  let acc = 0;
  for (const [s, e] of removed) {
    acc += e - s;
    const d = document.createElement("div");
    d.className = "cut";
    d.style.left = `${(s / dur) * 100}%`;
    d.style.width = `${Math.max(0.25, ((e - s) / dur) * 100)}%`;
    tl.appendChild(d);
  }
  const ph = document.createElement("div");
  ph.className = "ph";
  ph.id = "vPh";
  tl.appendChild(ph);
  const keep = base.reduce((a, [s, e]) => a + (e - s), 0) - acc;
  const effN = verbatimCuts().filter((c) => effective(c.s, c.e) >= 0.05).length;
  $("vSum").innerHTML = `已删 <b>${effN} 段 · ${acc.toFixed(1)}s</b><br>保留 ${t2(keep)}`;
  paintSub(keep);
}

/* ── 预览播放器 ───────────────────────────────────────────── */

function syncVPlay() {
  const v = $("vVideo"), b = $("vPlay");
  if (!b) return;
  b.classList.toggle("paused", !v.src || v.paused || v.ended);
}

function attachVideo() {
  const v = $("vVideo");
  const src = `/api/video?name=${encodeURIComponent(V.name)}&src=proxy`;
  if (!v.src.endsWith(src)) v.src = src;
  v.onloadedmetadata = () => {
    paintTime();
    paintScrub();
  };
  syncVPlay();
  if (!v._wired) {
    v._wired = true;
    v.addEventListener("timeupdate", () => {
      paintTime();
      paintScrub();
      // 当前字高亮常驻：不管「跟随」开没开，播到哪个字都要看得见 ——
      // 那个开关只决定「要不要自动滚过去」（见 paintNow 里的 V.following）
      paintNow();
      if (V.previewTo && v.currentTime > V.previewTo) {
        v.pause();
        V.previewTo = 0;
        $("vPlay").classList.add("paused");
        syncVPlay();
      }
    });
    // 和主页同一个原则：图标只反映播放器真实状态，不靠各处手动加/删 class
    ["play", "playing", "pause", "ended", "emptied", "loadedmetadata"].forEach((ev) => {
      v.addEventListener(ev, syncVPlay);
    });
    v.addEventListener("error", () => {
      // 代理还没转好时退回原片，别让预览区一片黑
      if (!v.src.includes("src=raw")) v.src = `/api/video?name=${encodeURIComponent(V.name)}&src=raw`;
    });
  }
}

function paintTime() {
  const v = $("vVideo");
  const d = v.duration || V.doc?.dur || 0;
  $("vTc").textContent = t2(v.currentTime);
  $("vTime").textContent = `${t2(v.currentTime)} / ${t2(d)}`;
  const ph = $("vPh");
  if (ph && d) ph.style.left = `${(v.currentTime / d) * 100}%`;
}

function paintScrub() {
  const v = $("vVideo");
  const d = v.duration || 1;
  const p = Math.max(0, Math.min(100, (v.currentTime / d) * 100));
  $("vFill").style.width = p + "%";
  $("vDot").style.left = p + "%";
}

let lastNow = -1;
function paintNow() {
  const v = $("vVideo");
  const ws = V.doc?.words || [];
  const t = v.currentTime;
  let idx = -1;
  // 二分找当前字（逐字稿按时间升序，线性扫 436 个字其实也够，但长素材会明显掉帧）
  let lo = 0, hi = ws.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < ws[mid].s) hi = mid - 1;
    else if (t >= ws[mid].e) lo = mid + 1;
    else { idx = mid; break; }
  }
  if (idx === lastNow) return;
  const box = $("vdoc");
  if (!box) return;
  box.querySelectorAll(".w.now").forEach((el) => el.classList.remove("now"));
  box.querySelectorAll(".vp.cur").forEach((el) => el.classList.remove("cur"));
  // 预览放的是**原片**（proxy），被剪掉的字在这儿是真的能听见的，照样跟着高亮 ——
  // 否则播到剪掉的区间时整页毫无反应，看着像跟随坏了
  if (idx < 0 || !ws[idx]) { lastNow = -1; return; }
  lastNow = idx;
  const el = box.querySelector(`.w[data-i="${idx}"]`);
  if (el) {
    el.classList.add("now");
    el.closest(".vp")?.classList.add("cur");
    if (!V.following) return;   // 高亮照画，但不自动滚动 —— 手在别处读稿时被拽走最烦
    // 只在当前字跑出可视区（或贴近上下边缘）时才滚，否则每读一个字都滚一下，正文一直在抖
    const bb = box.getBoundingClientRect();
    const rb = el.getBoundingClientRect();
    if (rb.top < bb.top + 56 || rb.bottom > bb.bottom - 72) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function seek(t) {
  const v = $("vVideo");
  if (!isFinite(t)) return;
  v.currentTime = Math.max(0, Math.min((v.duration || 1e9), t));
}

function previewAround(cut) {
  playContext(cut.s, cut.e, 1.2, 1.0);
}

function stopFollow() {
  if (V.raf) cancelAnimationFrame(V.raf);
  V.raf = null;
}

/* ── 事件 ────────────────────────────────────────────────── */

function wireVerbatim() {
  $("btnVerbatim").addEventListener("click", () => (V.on ? closeVerbatim() : openVerbatim()));
  $("vBack").addEventListener("click", closeVerbatim);
  $("vApply").addEventListener("click", async () => {
    try {
      await saveDecisions();
      closeVerbatim();
      toast("已保存，回审核台点「应用并重剪」");
    } catch (e) { toast(e.message, true); }
  });
  $("vUndo").addEventListener("click", () => undoLast(null));
  $("vSelCancel").addEventListener("click", clearSel);
  $("vSelGo").addEventListener("click", deleteSel);

  document.querySelectorAll(".dbar .chip").forEach((b) =>
    b.addEventListener("click", () => setFilter(b.dataset.f)));
  $("vPick").addEventListener("click", selectAllFillers);
  $("vNext").addEventListener("click", nextUncertain);
  $("vUncNext").addEventListener("click", nextUncertain);

  $("vFind").addEventListener("input", (e) => {
    V.find = e.target.value;
    applyFind();
  });

  // 选择：mouseup 后取一次，再 debounce —— 拖选过程中每帧算一遍没有必要
  let tmr = null;
  const kick = () => {
    clearTimeout(tmr);
    tmr = setTimeout(syncSel, 60);
  };
  $("vdoc").addEventListener("mouseup", kick);
  $("vdoc").addEventListener("keyup", kick);
  document.addEventListener("selectionchange", () => {
    if (V.on && !V.busy) kick();
  });

  // 点水词 → 选中整词并播上下文；点模型不确定的句子 → 选中整句并播上下文；点普通字 → 跳转
  $("vdoc").addEventListener("click", (e) => {
    const el = e.target.closest?.(".w");
    if (!el) return;
    const i = +el.dataset.i;
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;    // 正在拖选，别打断
    // 批量选区还亮着时点正文 = 放弃批量选择，改看这一个字
    if (isBulk()) { V.sel = null; paintBulkSel(); paintSelBar(); }
    const f = fillerAt(i);
    if (f && !isCut(i)) {
      // 水词也一起给上下文：一个字一个词地删，最需要「前后到底在说什么」这个判断依据
      selectToken(f);
      const ws = V.doc.words;
      if (ws[f.from] && ws[f.to]) playContext(ws[f.from].s, ws[f.to].e, 1.2, 1.2);
      return;
    }
    const u = V.dead.has(i) ? null : uncAt(i);
    if (u) { V.uncIdx = V.unc.indexOf(u); return focusUncertain(u, true); }
    hideUncBar();
    const w = V.doc.words[i];
    if (w) seek(w.s);
  });

  $("vDelList").addEventListener("click", (e) => {
    const id = e.target.dataset?.undo;
    if (id) return undoLast(id);
    const row = e.target.closest?.(".di");
    if (!row) return;
    const c = verbatimCuts().find((x) => x.id === row.dataset.id);
    if (!c) return;
    // 点整行 = 「我删的是哪几个字」：正文高亮并滚过去，再播切口前后各 1.2s
    V.pick = { id: c.id, s: c.s, e: c.e };
    paintPick();
    $("vdoc").querySelector(".w.pick")?.scrollIntoView({ block: "center", behavior: "smooth" });
    playContext(c.s, c.e, 1.2, 1.2);
  });

  $("vPlay").addEventListener("click", () => {
    const v = $("vVideo");
    V.previewTo = 0;
      if (v.paused) v.play().catch(() => {}); else v.pause();
    syncVPlay();
  });
  $("vScrub").addEventListener("click", (e) => {
    const v = $("vVideo");
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * (v.duration || 0));
  });
  $("vTl").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * (V.doc?.dur || 0));
  });
  $("vFollow").addEventListener("click", () => {
    V.following = !V.following;
    $("vFollow").classList.toggle("on", V.following);
  });

  document.addEventListener("keydown", (e) => {
    if (!V.on) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (typing) return;
    // 确认框开着时只有 Esc 有意义：不加这道判断，第二次按 Del 会再弹一层、
    // 空格还会把底下的播放器点着（弹窗在视觉上挡住了，但事件照样冒泡到页面）。
    if (!$("bulkModal").hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeBulkAsk(false); }
      else if (!["Enter", " ", "Tab"].includes(e.key)) e.preventDefault();
      return;   // 其余键一律不往下走：空格不能把底下的播放器点着
    }
    if (e.key === "Escape") { e.preventDefault(); return V.sel ? clearSel() : closeVerbatim(); }
    if ((e.key === "Delete" || e.key === "Backspace") && V.sel) { e.preventDefault(); return deleteSel(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); return undoLast(null); }
    if (e.key === " ") { e.preventDefault(); $("vPlay").click(); }
  });
}

// 顶栏入口：没有逐字稿时禁用（首剪还没跑完、或老产物没逐字时间戳）
function syncVerbatimBtn() {
  const b = $("btnVerbatim");
  if (!b) return;
  const ok = !!(S.name && S.tl);
  b.disabled = !ok;
  b.title = ok ? "逐字剪：看着逐字稿删水词" : "跑完一轮初剪后才能逐字剪";
}

wireVerbatim();
setInterval(syncVerbatimBtn, 1200);
