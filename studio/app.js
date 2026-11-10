// 剪辑台前端 —— 无框架，只跟本机 /api 说话。
// 核心约定：审核决定只写 overrides.json，重剪走 reexport.mjs，永不重跑 ASR/LLM。

const $ = (id) => document.getElementById(id);
const api = async (p, opt = {}) => {
  const r = await fetch(p, opt);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
};
const postJSON = (p, obj) => api(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}),
});

const S = {
  cfg: null, file: null, name: null,
  projects: [], gapAsked: new Set(),   // gapAsked：每条素材只自动弹一次「选气口标准」
  // 首轮的气口标准由用户选（上传后弹窗），跑完就成了这条素材的既成事实；
  // 记在 localStorage 里，重试/存 Key 后补跑都沿用同一个标准，不再问第二遍。
  gapMode: localStorage.getItem("studio.gapMode") === "tight" ? "tight" : "normal",
  awaitStart: false,       // 当前素材「上传了但第一轮还没开始」→ 文件卡里给「选择气口标准并开始」
  gapTight: false,         // 当前这一版是不是收紧版（顶栏「收紧气口」据此换文案）
  tl: null, review: [], active: null, media: null,
  verbatimFocus: null,   // 「待确认」跳到逐字剪时带过去的句子 {id,s,e}
  subCuts: [], subSel: null,   // 字幕条：自己标的「剪掉」区间 / 当前选中的第几句
  versions: [], curVer: 0, viewVer: 0,
  running: false, mode: "cut", src: "proxy", timer: null,
  rate: 1,                 // 播放倍速：跟着播放器走，切素材/切源都保留
  logOpen: false,          // 处理日志是否展开（展开才去拉完整日志）
  logText: "", logLines: [],
  cost: null,              // 最近一轮的 API 花费（work/run-usage.json）
};

// 待确认只做「告知」：模型想删、护栏拦住的地方，逐条列出句子和理由，
// 但不再让用户在这里拍板（删/留/听上下文全部迁到逐字剪：那里能选任意几个字，粒度更细）。
// 语气词（filler-*）由服务端在 clipReviewItems 里剔除，不进队列。
const KIND = {
  "offtopic-mid": ["跑题 · 中段", "b"],
  "echo-tail": ["收尾呼应", "b"],
  "slip-noref": ["超长重说", "b"],
  "slip-weak": ["口误 · 证据不足", "b"],
  "paraphrase-weak": ["换说法 · 证据不足", "b"],
  "paraphrase-dir": ["换说法 · 方向", "b"],
  "paraphrase-short": ["换说法 · 过短", "b"],
  "dep-keep": ["前件保护", "b"],
  "logic-link": ["逻辑续接", "b"],
  "batch-over": ["批量超限", "r"],
};
const fmt = (t) => {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60), s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ui-20261009_C0793-080536 → 20261009_C0793
const prettyName = (n) => String(n || "").replace(/^ui-/, "").replace(/-\d{6}$/, "");

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

// ───────────────────────── 本次花费 ─────────────────────────
// 数据源：run.mjs 收尾写的 work/run-usage.json（经 /api/cost）。只做展示，不参与任何判断；
// 拿不到就整块隐藏——记账是可选的，不能因为它坏了让版面闪一个空胶囊。
const COST_TAG = {
  retake: "重说裁决",
  filler: "语气词裁决",
  redundancy: "语义冗余扫描",
  asrfix: "错字纠错",
  directive: "补充要求",
  "note-directive": "补充要求",
  fillerscan: "水词标注",
  "inner-restart": "段内起头",
};
const cost2 = (v, d = 4) => Number(v || 0).toFixed(d);
const tok2 = (n) => {
  n = Number(n || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
};
const when2 = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function loadCost() {
  if (!S.name) { $("costWrap").hidden = true; return; }
  let u = null;
  try {
    u = (await api(`/api/cost?name=${encodeURIComponent(S.name)}`)).usage;
  } catch { u = null; }   // 老工程/记账失败：当作没有，不打扰用户
  S.cost = u;
  paintCost();
}

function paintCost() {
  const wrap = $("costWrap"), btn = $("costPill"), val = $("costVal"), pop = $("costPop");
  const u = S.cost;
  // 跑批中：账本还没写完（首剪）或写的是上一轮（重跑），显示金额都会误导 —— 统一占位
  if (S.running) {
    wrap.hidden = false;
    btn.classList.add("load");
    val.textContent = "计费中";
    pop.hidden = true;
    btn.classList.remove("on");
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  btn.classList.remove("load");
  if (!u || !u.total) { wrap.hidden = true; pop.hidden = true; return; }
  wrap.hidden = false;
  val.textContent = `¥${cost2(u.total, u.total < 0.1 ? 4 : 3)}`;

  // 明细：转写 + 各类裁决，按金额从大到小（用户第一眼看到的就是最贵的那个）
  const rows = [];
  const asrTxt = (u.asr || []).map((a) => `${Number(a.seconds).toFixed(1)}s`).join(" + ");
  if (u.asrCost > 0 || (u.asr || []).length) {
    rows.push({ n: "语音转写", t: asrTxt || "—", v: u.asrCost || 0 });
  }
  for (const r of u.llm || []) {
    rows.push({
      n: COST_TAG[r.tag] || r.tag,
      t: `${tok2(r.in)}→${tok2(r.out)}`,
      v: r.cost || 0,
    });
  }
  rows.sort((a, b) => b.v - a.v);
  const total = Math.max(u.total, 1e-9);
  const llmPct = Math.max(0, Math.min(100, ((u.llmCost || 0) / total) * 100));
  const cache = (u.llm || []).reduce((a, r) => a + (r.cache || 0), 0);

  pop.innerHTML = `
    <div class="cp-head">
      <div class="cp-sum"><small>¥</small>${cost2(u.total)}</div>
      <div class="cp-cnt">${u.total < 0.1 ? `≈ ${(u.total * 100).toFixed(1)} 分` : ""}</div>
    </div>
    <div class="cp-sub">${when2(u.at)} · ${esc(u.model || "—")}</div>
    <div class="cp-bar"><i class="m" style="width:${llmPct.toFixed(1)}%"></i><i class="a" style="width:${(100 - llmPct).toFixed(1)}%"></i></div>
    <div class="cp-rows">${rows.map((r) => `
      <div class="cp-row"><span class="n">${esc(r.n)}</span><span class="t">${esc(r.t)}</span><span class="v">${cost2(r.v)}</span></div>`).join("")}
    </div>
    <div class="cp-sep"></div>
    <div class="cp-foot">
      <b>模型 ¥${cost2(u.llmCost)}</b> · <b>转写 ¥${cost2(u.asrCost)}</b>${cache ? ` · 缓存命中 ${tok2(cache)} token` : ""}<br>
      ${u.partial ? "本次运行中途结束，这里是已发生的部分。" : ""}
    </div>`;
}

function closeCostPop() {
  $("costPop").hidden = true;
  $("costPill").classList.remove("on");
  $("costPill").setAttribute("aria-expanded", "false");
}

$("costPill").onclick = (e) => {
  e.stopPropagation();
  if ($("costPop").hidden) {
    paintCost();
    $("costPop").hidden = false;
    $("costPill").classList.add("on");
    $("costPill").setAttribute("aria-expanded", "true");
  } else closeCostPop();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("costPop").hidden) closeCostPop();
});
document.addEventListener("click", (e) => {
  const wrap = $("costWrap");
  if (wrap.hidden || wrap.contains(e.target)) return;
  closeCostPop();
});

// ───────────────────────── 配置 ─────────────────────────
async function loadConfig() {
  const c = await api("/api/config");
  S.cfg = c;
  $("keyDot").className = "live " + (c.hasKey ? "" : "off");
  $("keyState").textContent = c.hasKey ? "已连接" : "未配置";
  $("apiKey").placeholder = c.hasKey ? c.masked : "sk-...";
  $("modelName").textContent = c.model || "qwen3.5-plus";
  paintExportPath();
  // 换版本后第一次打开：告诉用户工程还在、旧版去哪了（每份接管记录只提示一次）
  const up = c.upgrade;
  if (up && up.at && localStorage.getItem("studio.upgradeAt") !== up.at) {
    localStorage.setItem("studio.upgradeAt", up.at);
    const n = up.projects || 0;
    const retired = (up.retired || []).length;
    setTimeout(() => toast(retired
      ? `已接管旧版数据：${n} 个工程，旧版已移入回收站`
      : `已接管旧版数据：${n} 个工程`), 800);
  }
}

function paintExportPath() {
  if (!S.cfg) return;
  // .env 里可能写成 C:/a/b（正斜杠）也可能写成 C:\a\b，统一显示成本机习惯的反斜杠
  let dir = (S.cfg.exportDir || "").replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:/.test(dir) || dir.includes("\\")) dir = dir.replace(/\//g, "\\");
  // 配置里的路径在这台机器上用不了（多半是目录从别的电脑整份拷过来）→ 明说，别让人对着空文件夹猜
  const w = $("pathWarn");
  if (S.cfg.exportDirFallback) {
    w.hidden = false;
    w.textContent = `配置里的路径「${S.cfg.exportDirWant || "空"}」在本机不可用，已临时改用 ${dir}。点「更改」重新选一个。`;
  } else {
    w.hidden = true;
  }
  if (!S.name) { $("exportPath").textContent = dir ? `${dir}\n（剪辑完成后生成 <任务名>.mp4）` : "—"; return; }
  // 正在回看旧版时显示该版的留档文件，避免「写着最新版路径、点开却是旧版」
  const viewingOld = (S.versions || []).length > 1 && S.viewVer && S.viewVer !== S.curVer;
  $("exportPath").textContent = `${dir}\\${S.name}${viewingOld ? `.v${S.viewVer}` : ""}.mp4`;
}

$("eye").onclick = () => {
  const i = $("apiKey");
  const show = i.type === "password";
  i.type = show ? "text" : "password";
  $("eye").textContent = show ? "隐藏" : "显示";
};

$("btnTest").onclick = async () => {
  const b = $("btnTest");
  b.disabled = true; b.textContent = "测试中…";
  try {
    const key = $("apiKey").value.trim();
    if (key) await postJSON("/api/config", { apiKey: key });
    const r = await postJSON("/api/config/test");
    b.textContent = r.ok ? `连通 ${r.ms}ms` : "连接失败";
    toast(r.ok ? `Key 可用（${r.ms}ms）` : `连接失败：${r.error}`, !r.ok);
    await loadConfig();
  } catch (e) { b.textContent = "连接失败"; toast(e.message, true); }
  setTimeout(() => (b.textContent = "测试连接", (b.disabled = false)), 1800);
};

$("btnSaveKey").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return toast("先填入 Key", true);
  try {
    await postJSON("/api/config", { apiKey: key });
    await loadConfig();
    $("apiKey").value = "";
    toast("已写入本机 .env");
    // Key 是起跑的硬前置：存好后把「等着选标准开跑」的素材直接跑起来，标准沿用他刚才选的
    if (!S.running && S.awaitStart && S.file) await runCut();
  } catch (e) { toast(e.message, true); }
};

// ───────────────────────── 素材列表（顶栏下拉）─────────────────────────
// 一条素材 = 一个工程。下拉里始终是「所有上传过的素材」，点哪个就把版面换成哪个工程，
// 不是只看最近一条 —— 否则上传第二条时第一条就从界面上消失了。
function paintProjects() {
  const sel = $("projSel");
  const list = S.projects || [];
  if (!list.length) {
    sel.innerHTML = `<option value="">暂无素材</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // 同名素材（同一个文件传了两次）会出现多条，光看标题分不清 → 这类补一个上传时刻
  const dup = {};
  list.forEach((p) => { dup[p.title] = (dup[p.title] || 0) + 1; });
  const hhmm = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  };
  const label = (p) => {
    const d = p.dur ? `${p.dur.toFixed(0)}s` : "—";
    const st = p.state === "running" ? `处理中 ${p.pct || 0}%`
      : p.state === "idle" ? "待处理"
      : p.state === "failed" ? "失败"
      : p.out && p.out.dur ? `已初剪 ${p.out.dur.toFixed(0)}s` : "已初剪";
    const t = dup[p.title] > 1 ? ` ${hhmm(p.at)}` : "";
    return `${p.title}${t} · ${d} · ${st}`;
  };
  let html = list.map((p) =>
    `<option value="${esc(p.name)}"${p.name === S.name ? " selected" : ""}>${esc(label(p))}</option>`).join("");
  // 刚上传、列表请求还没回来时，先让当前素材在下拉里有个位置（否则显示成上一个项目）
  if (S.name && !list.some((p) => p.name === S.name)) {
    html = `<option value="${esc(S.name)}" selected>${esc(prettyName(S.name))} · 处理中</option>` + html;
  }
  sel.innerHTML = html;
}

async function loadProjects() {
  try {
    const r = await api("/api/projects");
    S.projects = r.items || [];
  } catch { /* 列表挂了不影响当前工程使用 */ }
  paintProjects();
  return S.projects;
}

// 清空「上一个素材」残留的版面：时间轴、审核项、版本下拉、预览画面
function resetProjectView() {
  // 换素材时把三个弹窗都收掉：弹窗里的选择/补充要求是针对上一条素材的，
  // 留着会让用户在 B 的版面上确认 A 的操作（尤其「开始剪辑」会把当前工程直接跑起来）
  closeTightModal(); closeGapModal();
  S.tl = null; S.review = []; S.active = null; S.media = null;
  S.versions = []; S.curVer = 0; S.viewVer = 0;
  S.subCuts = []; S.subSel = null;
  S.awaitStart = false; S.gapTight = false;   // 换工程时这两个状态跟着换，别串到上一条素材
  $("pins").innerHTML = ""; $("gaps").innerHTML = ""; $("ruler").innerHTML = ""; $("subs").innerHTML = "";
  $("statDur").textContent = "—"; $("statSegs").textContent = "—";
  $("stQueue").textContent = "—"; $("rvCount").textContent = "0 处";
  $("rvProg").textContent = "";
  $("verSel").hidden = true; $("verList").hidden = true;
  $("rvHint").hidden = true;
  $("btnRetry").hidden = true;
  // 花费是「这条素材」的，切工程/换素材时必须先收起来，等新工程的账本回来再显示
  S.cost = null;
  $("costWrap").hidden = true;
  $("costPop").hidden = true;
  $("costPill").classList.remove("on");
  $("stElapsed").textContent = "—";
  setLogs("");
  $("rlist").innerHTML = `<div class="emptyv">
    <svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-3-3m3 3l3-3M4 19h16"/></svg>
    还没有待确认项<br/>选好气口标准后开始初剪</div>`;
  paintVersions();
  paintTightBtn();
  paintStartBtn();
  setStep(null);
  // 画面也要清，否则切到还没处理的素材时还挂着上一条的视频
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("pvEmpty").hidden = false;
  $("pvNote").hidden = true;
  S.src = "";
}

// ───────────────────────── 处理日志（折叠 / 展开）─────────────────────────
// 折叠时只露最新 6 行（省地方）；点标题展开后去 /api/logs 拉本次运行的**完整**日志。
// 轮询里的 st.logs 只带最后几个输出块，展开态不能拿它覆盖，否则一刷新就又变回几行。
function setLogs(text) {
  S.logText = String(text || "");
  S.logLines = S.logText.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  renderLogs();
}

function renderLogs() {
  const box = $("logs");
  const all = S.logLines;
  if (!all.length) {
    box.innerHTML = `<div><em>·</em><span>等待素材开始处理</span></div>`;
    return;
  }
  // 用户往上翻着看时不把他拽回底部（跑批时每 1.2s 重绘一次，否则根本没法读）
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
  const keep = box.scrollTop;
  const lines = S.logOpen ? all : all.slice(-6);
  box.innerHTML = lines.map((l) => {
    const warn = /⚠️|✗|失败|错误/.test(l);
    return `<div><em>·</em><span class="${warn ? "warn" : ""}" title="${esc(l)}">${esc(l.replace(/^\s+/, ""))}</span></div>`;
  }).join("");
  if (S.logOpen) box.scrollTop = atBottom ? box.scrollHeight : keep;
}

async function loadFullLogs() {
  if (!S.name) return;
  try {
    const r = await api(`/api/logs?name=${encodeURIComponent(S.name)}`);
    if (r && typeof r.text === "string" && r.text.trim()) setLogs(r.text);
  } catch { /* 日志拿不到就保持现状，不打断审核 */ }
}

function paintLogOpen() {
  $("logCard").classList.toggle("open", S.logOpen);
  const b = $("btnLogToggle");
  b.textContent = S.logOpen ? "收起" : "展开";
  b.setAttribute("aria-expanded", String(S.logOpen));
  $("logHead").title = S.logOpen ? "点击收起日志" : "点击展开完整日志";
  renderLogs();
}

async function toggleLogs(force) {
  const next = force == null ? !S.logOpen : !!force;
  if (next === S.logOpen) return;
  S.logOpen = next;
  localStorage.setItem("studio.logOpen", S.logOpen ? "1" : "0");
  paintLogOpen();
  if (S.logOpen) {
    await loadFullLogs();
    // 日志卡在左栏最底下，展开后会长出可视区 —— 自动滚到能看全的位置
    try { $("logCard").scrollIntoView({ block: "end", behavior: "smooth" }); } catch {}
  }
}

$("btnLogToggle").onclick = (e) => { e.stopPropagation(); toggleLogs(); };
$("logHead").onclick = () => toggleLogs();

$("projSel").onchange = (e) => switchProject(e.target.value);

async function switchProject(name) {
  if (!name || name === S.name) return;
  // 逐字剪是整页、数据全在 V 里（V.name / V.doc / V.dead / V.all），而删字和存决定带的都是 V.name。
  // 只改 S.name 不重开的话，屏幕上是上一条素材的稿子，删下去的字却会写进「V.name 指向的那条」——
  // 表现就是「切了工程没反应」，实际是数据错位。所以换工程必须把逐字剪整页重开一次。
  const stayVerbatim = V.on;
  if (stayVerbatim) closeVerbatim();   // 先收掉旧稿：切换过程中旧数据不能再被点、被删
  S.verbatimFocus = null;
  clearInterval(S.timer); S.timer = null; S.running = false;
  S.name = name;
  localStorage.setItem("studio.name", name);
  resetProjectView();
  paintExportPath();
  await restore(name);
  paintProjects();
  if (!stayVerbatim) return;
  // 新素材还没跑过初剪就没有逐字稿，只能退回审核台（气口标准那一关还在前面）
  if (!S.tl) {
    return toast(S.running
      ? `${prettyName(name)} 正在处理，跑完再用逐字剪`
      : `${prettyName(name)} 还没剪过，跑完初剪再用逐字剪`, true);
  }
  await openVerbatim();
  toast(`已切到 ${prettyName(name)}`);
}

// ───────────────────────── 左栏折叠 ─────────────────────────
// 折叠后左栏只剩 44px 竖条（展开箭头 + 1~5 步骤点），316px 让给中栏预览。
// 状态写 localStorage：习惯收起的人每次刷新都要再点一次会很烦。
const LEFT_FOLD_KEY = "studio.leftFolded";
let foldTimer = 0;
function setLeftFolded(on, remember = true) {
  const fold = !!on;
  document.querySelector(".body").classList.toggle("fold-left", fold);
  $("leftFold").setAttribute("aria-expanded", fold ? "false" : "true");
  if (remember) {
    try { localStorage.setItem(LEFT_FOLD_KEY, fold ? "1" : "0"); } catch { /* 隐私模式写不了，忽略 */ }
  }
  // 中栏宽度变了：波形/标尺/字幕都按像素铺，跟 window.resize 一样要重画。
  // 必须等 160ms 的列宽过渡走完再量，否则量到的还是旧宽度。
  clearTimeout(foldTimer);
  foldTimer = setTimeout(() => {
    if (S.tl) { paintWave(); paintRuler(); paintSubs(); }
  }, 200);
}
$("leftFold").onclick = () => setLeftFolded(true);
$("railUnfold").onclick = () => setLeftFolded(false);

// ───────────────────────── 上传 ─────────────────────────
const drop = $("drop");
drop.onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => e.target.files[0] && upload(e.target.files[0]);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) upload(f);
});

async function upload(file) {
  const meta = $("fMeta");
  $("fileCard").hidden = false;
  $("fName").textContent = file.name;
  meta.textContent = "上传中…";
  try {
    const r = await api("/api/upload", {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name) },
      body: file,
    });
    // 换素材 = 换工程，上一个工程的画面/时间轴/审核项不能留在版面上
    S.file = r.file;
    S.name = r.key;
    localStorage.setItem("studio.name", r.key);
    resetProjectView();
    meta.innerHTML = `<i class="tag">${r.vertical ? "竖屏" : "横屏"} ${r.w}×${r.h}</i>${r.dur.toFixed(1)}s · ${(r.size / 1048576).toFixed(1)} MB`;
    paintExportPath();
    setStep("upload");
    // 立刻出画面：先直出原片，代理转好再自动切
    ensurePreview();
    // 下拉里立刻出现这条素材（上传即入列）
    await loadProjects();
    // v1.2 起不再上传完就开跑：先让用户定气口标准，定了才跑第一轮。
    S.awaitStart = true;
    paintStartBtn();
    // 上传不动上一轮的状态栏/日志，这里显式写回「待选择」，否则还挂着上一条素材的「待审核」
    setStatus("待选择气口标准", "● 待开始", "warn");
    openGapModal();
  } catch (e) {
    meta.textContent = "上传失败：" + e.message;
    toast("上传失败：" + e.message, true);
  }
}

// ───────────────────────── 气口标准（首轮开跑前必选）─────────────────────────
// 为什么放在开跑前而不是跑完再问：换标准只能对原片整轮重跑（转写 + 裁决重新计费），
// 所以「剪多干净」这件事必须在第一轮之前定下来，中间只在「收紧气口」这个入口允许改。
const gapLabel = (m) => (m === "tight" ? "收紧" : "正常");
// 标准按素材记（studio.gapMode.<工程名>），重试/存 Key 补跑才不会串到别的素材；
// 全局 studio.gapMode 只当「下次上传时默认选中哪个」。
const gapOf = (n) => {
  const v = localStorage.getItem("studio.gapMode." + n);
  return v === "tight" || v === "normal" ? v : (localStorage.getItem("studio.gapMode") === "tight" ? "tight" : "normal");
};
const rememberGap = (n, m) => {
  localStorage.setItem("studio.gapMode", m);
  if (n) localStorage.setItem("studio.gapMode." + n, m);
};

function paintStartBtn() {
  const b = $("btnStart");
  if (!b) return;
  b.hidden = !S.awaitStart;
  if (!S.awaitStart) return;
  b.disabled = !!S.running;
  b.textContent = "选择气口标准并开始";
}
function paintGapChoice(m) {
  S.gapMode = m === "tight" ? "tight" : "normal";
  document.querySelectorAll("#gapOpts .gapc").forEach((el) => {
    const on = el.dataset.mode === S.gapMode;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function openGapModal() {
  if (!S.name || !S.file) return toast("先上传素材", true);
  if (S.running) return toast("正在处理，等它跑完再选", true);
  if (S.curVer > 0) {
    // 已经出过成片：改标准等于整轮重跑，走顶栏「收紧气口」，别在这里开第二次入口
    return toast("这一条已经有成片了：改气口标准用顶栏「收紧气口」", true);
  }
  $("gapModal").hidden = false;
  paintGapChoice(S.gapMode);
}
function closeGapModal() { $("gapModal").hidden = true; }

$("btnStart").onclick = () => openGapModal();
$("gapClose").onclick = closeGapModal;
// 点遮罩 = 关闭，素材留在「待开始」；文件卡里那个按钮随时能把它再打开
$("gapModal").addEventListener("mousedown", (e) => { if (e.target === $("gapModal")) closeGapModal(); });
$("gapOpts").addEventListener("click", (e) => {
  const c = e.target.closest(".gapc");
  if (!c) return;
  paintGapChoice(c.dataset.mode);
  rememberGap(S.name, S.gapMode);   // 只是「选了一下」也记住：半路刷新回来还是这个选项
});

// 「开始剪辑」：选定的标准落 localStorage，然后开跑第一轮
$("gapGo").onclick = async () => {
  const b = $("gapGo");
  if (b.disabled) return;
  rememberGap(S.name, S.gapMode);
  closeGapModal();
  // 没 Key 也不吞掉这次选择：记在 S.gapMode，存 Key 后按同一标准补跑
  if (!(S.cfg && S.cfg.hasKey)) {
    toast(`已记下「${gapLabel(S.gapMode)}」，保存 API Key 后自动开始`, true);
    setStatus("待配置 Key", "● 暂停", "warn");
    return;
  }
  await runCut();
};

// ───────────────────────── 起跑 ─────────────────────────
// 首轮的气口标准取自 S.gapMode（用户在弹窗里选的，已落 localStorage）。
// 唯一的硬前置是 API Key —— 没配就留着素材，配好后按同一标准补跑。
async function runCut() {
  if (!S.name || !S.file) return toast("先上传素材", true);
  if (!S.cfg || !S.cfg.hasKey) return toast("先保存 API Key", true);
  if (S.running) return toast("正在处理，等它跑完再点", true);
  $("btnRetry").hidden = true;
  const tight = S.gapMode === "tight";
  try {
    await postJSON("/api/run", { file: S.file, name: S.name, tight });
    S.running = true;
    S.mode = "cut";
    S.awaitStart = false;
    paintStartBtn();
    paintCost();               // 顶部立刻切成「计费中」，别让上一轮的金额挂在那儿
    setStatus(`启动中 · 气口${gapLabel(S.gapMode)}`, "● 运行中", "warn");
    toast(`已开始剪辑 · 气口按「${gapLabel(S.gapMode)}」处理`);
    pollStart();
  } catch (e) {
    toast(e.message, true);
    $("btnRetry").hidden = false;
  }
}

$("btnRetry").onclick = (e) => {
  e.stopPropagation();          // 别让点「重试」顺带把日志卡收起/展开
  if (!S.name) return;
  runCut();                     // 沿用这条素材上次选的标准（见 gapOf）
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("tightModal").hidden) closeTightModal();
  if (!$("gapModal").hidden) closeGapModal();
});

// ───────────────────────── 「收紧气口」 ─────────────────────────
// 对原片重跑一轮：当前版冻结成 vN，新结果登记 vN+1，带 tight=true →
// 服务端注入 XUNJIAN_TIGHT_BREATH=1，剪辑层多做一遍逐帧能量掩膜。
// 语义上它只动停顿、不动文字裁决，所以不带补充要求、也不让用户选是否保留决定（一律保留）。
function paintTightBtn() {
  const b = $("btnTight");
  if (!b) return;
  const ok = !!S.name && S.curVer > 0 && !S.running && !!(S.cfg && S.cfg.hasKey);
  b.disabled = !ok;
  b.title = !S.name ? "先上传素材"
    : S.running ? "正在处理，等它跑完再点"
    : !(S.cfg && S.cfg.hasKey) ? "先保存 API Key"
    : S.curVer === 0 ? "第一轮跑完后可用（首轮的标准在上传时选）"
    : S.gapTight ? "当前已是收紧版；再点会对原片重跑一轮（裁决可能漂）"
    : "把停顿/换气全部剪掉：对原片重跑一轮，当前版本保留";
}
function openTightModal() {
  if (!S.name) return toast("先上传素材", true);
  if (S.running) return toast("正在处理，等它跑完再点", true);
  if (!(S.curVer > 0)) return toast("等第一轮跑完再用；首轮的标准在上传时选", true);
  // 弹窗只交代「当前这一版是不是收紧版」，别的不再展开
  $("tightStat").textContent = `当前 v${S.curVer} · ${S.gapTight ? "已是收紧版（气口收紧）" : "常规气口（未收紧）"}`;
  $("tightModal").hidden = false;
}
function closeTightModal() { $("tightModal").hidden = true; }
$("btnTight").onclick = openTightModal;
$("tightClose").onclick = closeTightModal;
$("tightCancel").onclick = closeTightModal;
$("tightModal").addEventListener("mousedown", (e) => { if (e.target === $("tightModal")) closeTightModal(); });

$("tightGo").onclick = async () => {
  const b = $("tightGo");
  if (b.disabled) return;
  b.disabled = true; b.textContent = "启动中…";
  try {
    const r = await postJSON("/api/recut", { name: S.name, tight: true, keepDecisions: true });
    closeTightModal();
    S.running = true; S.mode = "cut";
    paintCost(); paintTightBtn();
    S.tl = null; S.review = []; S.active = null;
    S.subCuts = []; S.subSel = null; $("subs").innerHTML = "";
    setStatus(`收紧气口中 v${r.from || 1} → v${r.to}`, "● 运行中", "warn");
    toast(`已开始收紧气口，结果会是 v${r.to}`);
    pollStart();
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false; b.textContent = "开始收紧";
  }
};

// ───────────────────────── 轮询 ─────────────────────────
function pollStart() {
  clearInterval(S.timer);
  S.timer = setInterval(tick, 1200);
  tick();
}

async function tick() {
  if (!S.name) return;
  try {
    const st = await api(`/api/state?name=${encodeURIComponent(S.name)}`);
    paintState(st);
    if (S.logOpen) await loadFullLogs();   // 展开着看日志时，跟着跑批刷新完整日志
    if (!st.running) {
      clearInterval(S.timer);
      S.timer = null;
      S.running = false;
      await loadProjects();     // 下拉里的状态（待处理 → 已初剪 / 失败）要跟着变
      if (st.exitCode === 0) {
        if (S.mode === "reexport") {
          await loadTimeline();          // 版本链与时长按新决定重算，决定状态也从 overrides 恢复
          setSrc("out", true);
          const v = S.curVer ? ` v${S.curVer}` : "";
          toast(`已按你的决定重剪完成${v} · 上一版仍在，可下拉对比`);
          setStatus("重剪完成", "● 就绪", "ok");
        } else {
          await loadTimeline();
          setSrc("out", true);
          const tn = st.tight && st.tight.applied ? ` · 收紧气口 -${st.tight.savedSec}s` : "";
          toast(`初剪完成 · ${st.reviewCount ?? 0} 条待确认${tn}`);
          setStatus("待审核", "● 就绪", "ok");
        }
      } else {
        toast(st.error || "处理失败，看日志", true);
        setStatus("失败", "● 失败", "warn");
        $("btnRetry").hidden = false;
        await loadCost();   // 失败也可能是跑了一半才挂的 —— 已经花掉的钱照样要让人看见
      }
    }
  } catch (e) {
    clearInterval(S.timer); S.timer = null; S.running = false;
    toast(e.message, true);
  }
}

function paintState(st) {
  $("stStage").textContent = st.stage || "—";
  $("stElapsed").textContent = st.elapsed ? `${Math.floor(st.elapsed / 60)}m${String(st.elapsed % 60).padStart(2, "0")}s` : "—";
  $("stQueue").textContent = st.reviewCount == null ? "—" : `${st.reviewCount} 条`;
  // 日志：折叠态用轮询带回的尾部几行；展开态由 /api/logs 提供完整日志（这里不能覆盖）
  if (!S.logOpen) setLogs(st.logs || "");
  // 步骤
  const pct = st.pct || 0;
  if (pct >= 5) setStep("upload");
  if (pct >= 22) setStep("asr");
  if (pct >= 72) setStep("judge");
  // 首剪跑完停在「审核」等用户；重新导出跑完就是整条流程走完，四个点全绿
  if (st.done && st.exitCode === 0) setStep(S.mode === "reexport" ? "done" : "review");
  if (st.outDur) $("statDur").innerHTML = `${st.outDur.toFixed(1)}<small>s</small>`;
  // 这一版用的气口标准（cut-plan.tight 有统计就说明收紧真跑过）
  S.gapTight = !!(st.tight && st.tight.applied);
  paintTightBtn();   // 跑批中/没成片时「收紧气口」要跟着禁用
  paintStartBtn();
}

function setStep(k) {
  // 「导出」不再是独立步骤：成片导出属于审核之后的收尾动作，顶栏不占位。
  // 跑完（含重新导出）传 "done" → 全部标成已完成。
  const order = ["upload", "asr", "judge", "review"];
  const idx = k === "done" ? order.length : order.indexOf(k);
  document.querySelectorAll("#steps .step").forEach((el) => {
    const i = order.indexOf(el.dataset.k);
    el.className = "step" + (i < idx ? " done" : i === idx ? " cur" : "");
  });
  // 左栏折叠后看不见那些卡片，这套圆点就是唯一能看出「跑到第几步」的地方
  document.querySelectorAll("#railSteps i").forEach((el) => {
    const i = order.indexOf(el.dataset.k);
    el.className = i < idx ? "done" : i === idx ? "cur" : "";
  });
}
function setStatus(stage, ready, cls) {
  $("stStage").textContent = stage;
  $("stReady").textContent = ready;
  $("stReady").className = cls || "ok";
}

// ───────────────────────── 时间轴 ─────────────────────────
// 待确认已经是只读清单（不再产生决定），所以这里不再需要「决定 ↔ 审核项」的回显匹配；
// 历史工程里已删过的条目由 carriedDecisions() 原样带进下一次重剪。

async function loadTimeline(syncVer = true) {
  // 切工程时会有多个 /api/timeline 在飞（逐字剪关闭时那一次、restore 里那一次）。
  // 回来得晚的那份属于上一条素材，直接丢掉 —— 否则 S.tl 被旧工程覆盖，
  // 界面上是新素材、时间轴和审核项却是上一条的。
  const want = S.name;
  const tl = await api(`/api/timeline?name=${encodeURIComponent(want)}`);
  if (want !== S.name) return;
  S.tl = tl;
  S.versions = tl.versions || [];
  S.curVer = tl.curVer || 0;
  // 默认跟到最新版；只有在明确回看旧版时才保留（避免每次重算时间轴都把用户拽回最新）
  const known = S.versions.some((x) => x.v === S.viewVer);
  if (syncVer || !known) S.viewVer = S.curVer;
  S.review = (tl.review || []).slice().sort((a, b) =>
    (a.priority || 9) - (b.priority || 9) || a.s - b.s);
  S.active = S.review.length ? S.review[0].id : null;
  // 字幕条的手剪区间（历史工程才有）从 overrides.json 回读：只用于显示，已无新增入口
  S.subCuts = (tl.decisions || [])
    .filter((d) => d && d.kind === "sub" && d.choice === "cut")
    .flatMap((d) => (d.cuts || []).filter((r) => Array.isArray(r) && r.length === 2).map((r) => [+r[0], +r[1]]));
  S.subSel = null;
  $("stQueue").textContent = `${S.review.length} 条`;
  $("rvCount").textContent = `${S.review.length} 处`;
  paintRuler();
  paintSubs();
  paintSubStat();
  paintGaps();
  paintPins();
  paintReview();
  paintRvStat();
  paintVersions();
  paintVerStats();
  paintExportPath();
  paintTightBtn();
  await loadCost();
}

// 统计卡跟着「正在看的那一版」走；顺带在两者不一致时说明原因
function paintVerStats() {
  const cur = (S.versions || []).find((x) => x.v === S.viewVer);
  const dur = cur && cur.dur ? cur.dur : S.tl ? S.tl.outDur : null;
  const segs = cur && cur.segs ? cur.segs : S.tl ? S.tl.segs.length : null;
  if (dur != null) $("statDur").innerHTML = `${dur.toFixed(1)}<small>s</small>`;
  if (segs != null) $("statSegs").innerHTML = `${segs}<small>段</small>`;

  const want = S.tl ? S.tl.outDur : null;
  const hint = $("rvHint");
  if (want != null && dur != null && Math.abs(want - dur) > 0.35) {
    hint.hidden = false;
    hint.innerHTML = `当前决定合计 <b>${want.toFixed(1)}s</b>，和你正在看的 v${S.viewVer}（${dur.toFixed(1)}s）不同 —— 点「应用并重剪」按当前决定生成新版本`;
  } else {
    hint.hidden = true;
  }
}

// 版本切换器：只有 2 版以上才出现。切换只改「看哪一版」，不影响当前决定。
function paintVersions() {
  const list = S.versions || [];
  const multi = list.length > 1;
  const sel = $("verSel");
  const box = $("verList");
  sel.hidden = !multi;
  box.hidden = !multi;
  if (!multi) { sel.innerHTML = ""; box.innerHTML = ""; return; }

  sel.innerHTML = list.map((x) => {
    const d = x.dur ? `${x.dur.toFixed(1)}s` : "—";
    const tag = x.v === S.curVer ? " · 最新" : x.kind === "cut" ? " · 首剪" : "";
    return `<option value="${x.v}"${x.v === S.viewVer ? " selected" : ""}>v${x.v} ${d}${tag}</option>`;
  }).join("");

  box.innerHTML = list.map((x) => {
    const d = x.dur ? `${x.dur.toFixed(1)}s` : "—";
    const note = x.note || (x.kind === "cut" ? "首剪" : `第 ${x.v} 版`);
    return `<div class="v${x.v === S.viewVer ? " on" : ""}${x.v === S.curVer ? " now" : ""}" data-v="${x.v}" title="${esc(note)}">
      <b>v${x.v}</b><i>${d}</i><span>${esc(x.v === S.curVer ? "最新 · " + note : note)}</span></div>`;
  }).join("");
  box.querySelectorAll(".v").forEach((el) => {
    el.onclick = () => pickVersion(Number(el.dataset.v));
  });
}

function pickVersion(v) {
  if (!v || v === S.viewVer) return;
  S.viewVer = v;
  paintVersions();
  paintVerStats();
  paintExportPath();
  setSrc("out", true);
  const it = (S.versions || []).find((x) => x.v === v);
  toast(`预览 v${v}${it && it.dur ? ` · ${it.dur.toFixed(1)}s` : ""}`);
}

function paintRuler() {
  if (!S.tl) return;
  const n = 6;
  $("ruler").innerHTML = Array.from({ length: n }, (_, i) =>
    `<span>${fmt((S.tl.rawDur * i) / (n - 1)).replace(/\.\d$/, "")}</span>`).join("");
}

function paintGaps() {
  if (!S.tl) return;
  const dur = S.tl.rawDur || 1;
  $("gaps").innerHTML = S.tl.gaps.map(([a, b]) =>
    `<i style="left:${(a / dur) * 100}%;width:${((b - a) / dur) * 100}%"></i>`).join("");
}

// ── 字幕条 ──
// 铺的是「原片逐句字幕」（raw-segs），不是保留段：已剪的句子也要在，否则看不出某句为什么不见了。
// 三种状态：可剪 / alg（算法已剪，灰掉不可点）/ cut（自己标的剪掉，等「应用并重剪」落盘）
function subKeptLen(x) {
  let n = 0;
  for (const [a, b] of S.tl.baseSegs || []) n += Math.max(0, Math.min(x.e, b) - Math.max(x.s, a));
  return n;
}
const subIsAlg = (x) => subKeptLen(x) < (x.e - x.s) * 0.55;
const subIsCut = (x) => S.subCuts.some(([a, b]) =>
  Math.min(x.e, b) - Math.max(x.s, a) > (x.e - x.s) * 0.5);

function paintSubs() {
  const box = $("subs");
  const list = (S.tl && S.tl.subs) || [];
  if (!list.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  const dur = S.tl.rawDur || 1;
  const W = box.clientWidth || 0;
  box.innerHTML = list.map((x, i) => {
    const alg = subIsAlg(x);
    const cut = !alg && subIsCut(x);
    const cls = ["s", alg ? "alg" : "", cut ? "cut" : "", i === S.subSel ? "on" : ""].filter(Boolean).join(" ");
    const l = (x.s / dur) * 100, w = ((x.e - x.s) / dur) * 100;
    // 块宽只够 1~2 个字时，露半个词反而更难认（"所…"这种）。放不下 3 个字就留空，
    // 全文交给悬停气泡
    const pw = (w / 100) * W;
    const label = pw >= 34 ? esc(x.z) : "";
    // 不要挂 title：浏览器原生气泡会同时弹在光标下方，和自绘的 .subtip 撞成"两条字幕"
    return `<div class="${cls}" data-i="${i}" style="left:calc(${l}% + 1px);width:calc(${w}% - 2px)">${label}</div>`;
  }).join("");
}

// 顶部统计：历史工程里手剪过的段数（入口已撤，只做只读展示）
function paintSubStat() {
  const el = $("subStat");
  if (!el) return;
  const n = S.subCuts.length;
  if (!n) { el.hidden = true; el.textContent = ""; return; }
  const sec = S.subCuts.reduce((a, [s, e]) => a + (e - s), 0);
  el.hidden = false;
  el.textContent = `字幕条手剪 ${n} 段 · ${sec.toFixed(1)}s`;
}

// 单击字幕块 = 定位 + 高亮（不再弹操作栏，也不再提供手剪）
function selectSub(i) {
  const x = S.tl && (S.tl.subs || [])[i];
  if (!x) return;
  if (subIsAlg(x)) return toast("这段已经被算法剪掉了");
  S.subSel = S.subSel === i ? null : i;
  paintSubs();
  if (S.subSel != null) seekTo(x.s + 0.05);
}

function paintPins() {
  if (!S.tl) return;
  const dur = S.tl.rawDur || 1;
  $("pins").innerHTML = S.review.map((it, i) => {
    const mid = (it.s + it.e) / 2;
    const cls = it.id === S.active ? "on" : "";
    return `<div class="pin ${cls}" style="left:${(mid / dur) * 100}%" data-id="${it.id}" title="${esc(it.text || "")}">
      <span class="st"></span><span class="lb">${i + 1}</span></div>`;
  }).join("");
  $("pins").querySelectorAll(".pin").forEach((el) => {
    el.onclick = () => selectItem(Number(el.dataset.id));
  });
}

/* 待确认 = 只读说明卡。
 * 这里不放任何「删/留」按钮：句子的粒度是 ASR 给的，用户常常只想删半句
 * （「那个老师呢就是」只删前三个字），在卡片上点「删掉」只能整句删，等于把人逼到粗粒度上。
 * 所以判断动作统一收进逐字剪（能拖选任意几个字），这里只负责说清「模型为什么想删、护栏为什么拦」。 */
function paintReview() {
  const box = $("rlist");
  if (!S.review.length) {
    box.innerHTML = `<div class="emptyv"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
      没有需要你拍板的地方<br/><span style="color:#3F485C">算法对这批剪切是有把握的</span></div>`;
    return;
  }
  box.innerHTML = S.review.map((it, i) => {
    const [label, tagCls] = KIND[it.kind] || [it.kind, ""];
    const cls = it.id === S.active ? "on" : "";
    const line = it.line || it.text || "";
    const hl = it.text && line.includes(it.text)
      ? esc(line).replace(esc(it.text), `<span class="hl">${esc(it.text)}</span>`)
      : esc(line);
    const llm = it.llm || {}, g = it.guard || {};
    const gv = g.value === undefined || g.value === "" ? "" : `${g.value}`;
    return `<article class="q ${cls}" data-id="${it.id}">
      <div class="qh">
        <span class="tag2 ${tagCls}">${esc(label)}</span>
        <span class="id">#${i + 1}</span>
        <span class="tt">${fmt(it.s)} · ${(it.e - it.s).toFixed(2)}s</span>
        <button class="a ghost jump" data-act="verbatim" title="到逐字剪选字删" aria-label="到逐字剪选字删">›</button>
      </div>
      <div class="qt">${hl}</div>
      <div class="why"><b>模型想删</b>（${esc(llm.reason || "—")}）<br/><b>护栏拦住</b>（${esc(g.rule || "")}${gv ? " " + esc(gv) : ""}${g.limit ? " / 阈值 " + esc(g.limit) : ""}）</div>
    </article>`;
  }).join("");
  box.querySelectorAll(".q").forEach((el) => {
    const id = Number(el.dataset.id);
    el.onclick = (e) => {
      if (e.target.closest?.("[data-act='verbatim']")) return editUncertainInVerbatim(id);
      selectItem(id);
    };
  });
}

// 「到逐字剪选字删」：把这一句作为待定项带过去，逐字剪打开后直接选中整句并播上下文
function editUncertainInVerbatim(id) {
  const it = S.review.find((x) => x.id === id);
  if (!it) return;
  S.verbatimFocus = { id: it.id, s: it.s, e: it.e };
  if (typeof openVerbatim === "function") return openVerbatim();
  toast("逐字剪不可用（缺少逐字时间戳）", true);
}

function paintRvStat() {
  const n = S.review.length;
  $("rvProg").textContent = n ? `${n} 处 · 默认保留` : "";
}

// ───────────────────────── 交互 ─────────────────────────
// 点卡片/时间轴上的钉 = 只定位到那一句，不播放、也不产生任何决定
function selectItem(id) {
  const it = S.review.find((x) => x.id === id);
  if (!it) return;
  S.active = id;
  paintPins(); paintReview();
  seekTo(it.s - 0.6);
}

// 待确认不再产生「删/留」决定：一律按保留处理。
// 但历史工程里已经明确删过的条目要原样带过去 —— 否则这次「应用并重剪」会把它悄悄恢复回来。
function carriedDecisions() {
  return (S.tl.decisions || []).filter((d) =>
    d && d.choice === "cut" && d.kind !== "verbatim" && d.kind !== "sub");
}

$("btnApply").onclick = async () => {
  if (!S.name || !S.tl) return toast("先跑一次剪辑", true);
  const decisions = carriedDecisions();
  // 历史工程里字幕条手剪的区间原样带上（新增入口已撤，但老结果不能在重建数组时被丢掉）
  for (const [s, e] of S.subCuts) decisions.push({ kind: "sub", choice: "cut", cuts: [[s, e]] });
  // 逐字剪删的字也一起带上：这里是从 S.review 重建整个数组，不显式搬过来就会被冲掉
  for (const d of S.tl.decisions || []) {
    if (d && d.kind === "verbatim" && d.choice === "cut") decisions.push(d);
  }
  try {
    await postJSON("/api/decisions", { name: S.name, decisions });
    S.running = true;
    S.mode = "reexport";
    $("btnApply").disabled = true;
    setStatus("重剪中", "● 运行中", "warn");
    await postJSON("/api/reexport", { name: S.name });
    pollStart();
    setTimeout(() => ($("btnApply").disabled = false), 4000);
  } catch (e) { toast(e.message, true); $("btnApply").disabled = false; }
};

// ───────────────────────── 播放器 ─────────────────────────
const video = $("video");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRC_LABEL = { raw: "原片", proxy: "原片", out: "成片" };
let errCount = 0;

function pvNote(html, warn) {
  const el = $("pvNote");
  if (!html) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.className = "pvnote" + (warn ? " warn" : "");
  el.innerHTML = html;
}

function setSrc(kind, force) {
  if (!S.name) return;
  // 同一个源且已经有 src 就不重挂，否则会把播放进度打断（重导出后要刷新，传 force）
  if (!force && kind === S.src && video.src) return;
  // 只有同一条时间线（原片↔代理 / 成片↔成片）才把进度带过去；
  // 原片 ↔ 成片 是两套时间轴，硬带会跳到完全无关的位置
  const sameLine = (S.src === "out") === (kind === "out");
  const t = sameLine ? (video.currentTime || 0) : 0;
  S.src = kind;
  $("pvBadge").textContent = SRC_LABEL[kind] || "原片";
  const tabSrc = kind === "out" ? "out" : "proxy";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.src === tabSrc));
  $("pvEmpty").hidden = true;
  const ver = kind === "out" ? `&v=${S.viewVer || 0}` : "";
  if (kind === "out") {
    const poster = `/api/poster?name=${encodeURIComponent(S.name)}&src=out&v=${S.viewVer || 0}`;
    video.poster = poster;
    // 元数据还没到时先按封面比例撑住版式，避免 300×150 默认框把版面跳一下
    const img = new Image();
    img.onload = () => { if (S.src === "out") video.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`; };
    img.src = poster;
  } else {
    video.poster = "";
    video.style.aspectRatio = "";
  }
  // 时长先用已知的计划值兜底，元数据到了会被 onloadedmetadata 覆盖
  if (S.tl) $("tcAll").innerHTML = `<em>/</em> ${fmt(kind === "out" ? S.tl.outDur : S.tl.rawDur).replace(/\.(\d)$/, "<em>.$1</em>")}`;
  video.src = `/api/video?name=${encodeURIComponent(S.name)}&src=${kind}${ver}`;
  video.load();
  syncPlayBtn();   // load() 会把播放器置回「停」，但不会补一个 pause 事件
  // 换源后播放位置已归零：时间码与进度条要立刻跟上，否则会停在上一套时间轴的旧位置上
  paintPlayPos(0);
  applyRate();      // load() 会把倍速打回 1×，切源后要把用户选的倍速捡回来
  video.addEventListener("loadedmetadata", function once() {
    video.removeEventListener("loadedmetadata", once);
    // 原片 ↔ 代理 是同一条时间线，切换时把进度带过去，用户不会觉得画面被重置
    if (t > 0.3) video.currentTime = Math.min(t, video.duration || t);
  });
}

// 把预览挂起来：先立刻出原片（不依赖转码），代理转好再无缝切过去。
// 之所以要「等」：代理是边转边写的，转码期间去读会拿到没有 moov 的半截文件，
// 浏览器直接 error 且不会自己恢复 —— 这正是「上传后预览黑屏」的根因。
let pvSeq = 0;
async function ensurePreview() {
  if (!S.name) return;
  const seq = ++pvSeq;
  const q = `/api/media?name=${encodeURIComponent(S.name)}`;
  let m = null;
  try { m = await api(q); } catch { m = null; }
  if (seq !== pvSeq) return;
  S.media = m;
  errCount = 0;

  if (m && m.proxy.ready) { setSrc("proxy", true); pvNote(""); return; }
  if (m && m.raw.ready) {
    setSrc("raw", true);
    pvNote(`正在生成精准预览（${m.proxy.pct || 0}%）· 现在看的是原片，审核拖动会略糙`);
  } else {
    pvNote("素材还在准备，稍等…");
  }

  for (let i = 0; i < 400; i++) {
    await sleep(900);
    if (seq !== pvSeq) return;
    let st;
    try { st = await api(q); } catch { continue; }
    if (seq !== pvSeq) return;
    S.media = st;
    if (st.proxy.ready) {
      const wasPlaying = !video.paused && !video.ended && !!video.src;
      setSrc("proxy", true);
      if (wasPlaying) video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
      pvNote("");
      return;
    }
    if (st.proxy.err) {
      pvNote(`精准预览没生成成功，先用原片顶上：${esc(st.proxy.err)}`, true);
      return;
    }
    if (st.raw.ready && S.src !== "raw") setSrc("raw", true);
    pvNote(`正在生成精准预览（${st.proxy.pct || 0}%）· 现在看的是原片，审核拖动会略糙`);
  }
}

document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.src === "out") {
      if (!S.tl && !S.curVer) return toast("还没有成片", true);
      setSrc("out", true);
      return;
    }
    // 「原片」优先给代理（seek 精准）；代理没好就退回直出原片，别按了个没反应的按钮
    const m = S.media;
    if (m && m.proxy.ready) { setSrc("proxy"); pvNote(""); }
    else if (m && m.raw.ready) { setSrc("raw"); pvNote("精准预览还在生成，先看原片 · 拖动会略糙"); }
    else ensurePreview();
    paintPins();
  };
});
$("verSel").onchange = (e) => pickVersion(Number(e.target.value));

// 播放键只有「在播 / 停着」两态，且必须由播放器自己说了算。
// 换源（video.load()）和从逐字剪退回来都会把 paused 变成 true，但浏览器这时不一定派发 pause 事件，
// 图标就会停在上一套状态（明明停了还显示⏸）。所以所有入口都只调这一个函数，不再各自加/删 class。
function syncPlayBtn() {
  const b = $("btnPlay");
  if (!b) return;
  b.classList.toggle("pause", !!video.src && !video.paused && !video.ended);
}

$("btnPlay").onclick = () => {
  if (!video.src) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
  syncPlayBtn();
};
["play", "playing", "pause", "ended", "emptied", "loadedmetadata", "seeked"].forEach((ev) => {
  video.addEventListener(ev, syncPlayBtn);
});

// 审核播放用哪个源：代理就绪就用代理（seek 准），否则退回原片
const reviewSrc = () => (S.media ? (S.media.proxy.ready ? "proxy" : "raw") : "proxy");

function seekTo(t) {
  if (!video.src) return;
  if (S.src !== reviewSrc()) setSrc(reviewSrc());
  const go = () => { video.currentTime = Math.max(0, Math.min(t, video.duration || t)); };
  if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
}

// playRange 已随「待确认」的『听上下文』按钮一起撤掉：听上下文改用逐字剪里的播放器
// （那边是原片逐字稿，点哪句播哪句，还能顺手选字删）。这里只保留定位。

// 时间码 + 进度条：换源归零与播放刷新共用一处，避免两套算法漂移
function paintPlayPos(t) {
  const d = video.duration || 1;
  const p = Math.max(0, Math.min(100, (t / d) * 100)) || 0;
  $("scrubFill").style.width = p + "%";
  $("scrubDot").style.left = p + "%";
  $("tcNow").innerHTML = fmt(t).replace(/\.(\d)$/, "<em>.$1</em>");
}

video.ontimeupdate = () => {
  paintPlayPos(video.currentTime);
  if (S.src !== "out" && S.tl) {
    $("playhead").style.left = `${(video.currentTime / (S.tl.rawDur || 1)) * 100}%`;
  }
};
video.onloadedmetadata = () => {
  errCount = 0;
  $("tcAll").innerHTML = `<em>/</em> ${fmt(video.duration).replace(/\.(\d)$/, "<em>.$1</em>")}`;
  applyRate();
};
video.onerror = () => {
  // 切换素材时会主动清掉 src，此时 error(4) 是预期内的，别当成加载失败去重试
  if (!video.getAttribute("src")) return;
  const e = video.error;
  const code = e ? e.code : 0;
  // 源还没准备好（刚上传/刚剪完文件还在收尾）→ 退避重试；只有连续失败才报错。
  // 之前是失败一次就 toast，用户看到的就是「上传后预览一直加载不出来」。
  if (S.name && errCount < 5) {
    errCount++;
    const wait = 800 * errCount;
    pvNote(`预览加载失败（${code}），${(wait / 1000).toFixed(1)}s 后重试 ${errCount}/5`, true);
    setTimeout(() => { if (S.name) setSrc(S.src, true); }, wait);
    return;
  }
  pvNote("");
  toast(`预览加载失败${code ? `（${code}）` : ""}，可在「导出地址」里打开成片`, true);
};

$("scrub").onclick = (e) => {
  if (!video.src) return;
  const r = e.currentTarget.getBoundingClientRect();
  const f = (e.clientX - r.left) / r.width;
  video.currentTime = f * (video.duration || 0);
};

// ───────────────────────── 播放倍速 ─────────────────────────
// 审核时 1.25×/1.5× 听语气词最省时间，慢速用来听切口。
// 注意 video.load() 会把 playbackRate 复位成 defaultPlaybackRate，所以两个都要设。
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
function applyRate() {
  try {
    video.defaultPlaybackRate = S.rate;
    video.playbackRate = S.rate;
  } catch { /* 元数据没到时设了也不生效，onloadedmetadata 里会再设一次 */ }
}
function paintRate() {
  const b = $("btnRate");
  b.textContent = `${S.rate}×`;
  b.classList.toggle("on", S.rate !== 1);
  b.title = S.rate === 1
    ? "播放倍速 1×（点击切换，右键复位）"
    : `播放倍速 ${S.rate}×（点击继续切换，右键复位 1×）`;
}
function setRate(r, quiet) {
  const v = RATES.includes(Number(r)) ? Number(r) : 1;
  S.rate = v;
  localStorage.setItem("studio.rate", String(v));
  applyRate();
  paintRate();
  if (!quiet) toast(`播放倍速 ${v}×`);
}
$("btnRate").onclick = () => {
  const i = RATES.indexOf(S.rate);
  setRate(RATES[(i + 1) % RATES.length]);
};
$("btnRate").oncontextmenu = (e) => {
  e.preventDefault();
  if (S.rate !== 1) setRate(1); else toast("已经是 1×");
};

$("track").onclick = (e) => {
  if (!S.tl) return;
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  seekTo(f * S.tl.rawDur);
};

// 字幕条：单击选中并定位（只是浏览锚点，不产生任何剪辑决定）
$("subs").addEventListener("click", (e) => {
  const el = e.target.closest(".s");
  if (el) selectSub(Number(el.dataset.i));
});

// 细切之后一块只有十来像素，字放不下 —— 悬停立刻把「时间 + 全文」浮出来，
// 不必先点一下才知道自己要删哪句。字幕块不再挂 title，全局只留这一个气泡，
// 否则浏览器原生气泡会在光标下方同时弹出，看起来像"两条字幕"。
const subTip = document.createElement("div");
subTip.className = "subtip";
subTip.hidden = true;
document.body.appendChild(subTip);

$("subs").addEventListener("mousemove", (e) => {
  const el = e.target.closest(".s");
  const x = el && S.tl ? (S.tl.subs || [])[Number(el.dataset.i)] : null;
  if (!x) { subTip.hidden = true; return; }
  subTip.innerHTML = `<b>${fmt(x.s)}–${fmt(x.e)}</b>${esc(x.z)}`;
  subTip.hidden = false;
  const w = subTip.offsetWidth, h = subTip.offsetHeight;
  subTip.style.left = `${Math.min(e.clientX + 12, innerWidth - w - 10)}px`;
  subTip.style.top = `${Math.max(8, e.clientY - h - 12)}px`;
});
$("subs").addEventListener("mouseleave", () => { subTip.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (S.subSel == null) return;
  const el = e.target || {};
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return;
  if (e.key === "Escape") { S.subSel = null; paintSubs(); }
});

// 波形（装饰，按宽度铺满）
function paintWave() {
  const w = $("wave");
  const n = Math.max(40, Math.floor(w.clientWidth / 4.2));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  w.innerHTML = Array.from({ length: n }, (_, i) => {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 11));
    return `<b style="height:${(10 + rnd() * 30 * env).toFixed(1)}px"></b>`;
  }).join("");
}
window.addEventListener("resize", () => { if (S.tl) { paintWave(); paintRuler(); paintSubs(); } });

// ───────────────────────── 导出 ─────────────────────────
// 「更改」：网页拿不到本地绝对路径（<input webkitdirectory> 只给相对名），
// 所以让本机服务弹一个系统文件夹选择器，再把选中的路径写回 .env。
$("btnEdit").onclick = async () => {
  const b = $("btnEdit");
  if (b.disabled) return;
  b.disabled = true; b.textContent = "选择中…";
  try {
    const r = await postJSON("/api/pick-dir", { initial: (S.cfg && S.cfg.exportDir) || "" });
    if (!r || !r.ok) {
      if (r && r.canceled) toast("已取消，导出路径没变");
      else toast((r && r.error) || "打不开文件夹选择器", true);
      return;
    }
    await saveExportDir(r.dir);
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false; b.textContent = "更改";
  }
};

async function saveExportDir(dir) {
  if (S.cfg) S.cfg.exportDir = dir;      // 先本地生效，避免回读到旧值闪一下
  paintExportPath();
  const saved = await postJSON("/api/config", { exportDir: dir, name: S.name || "" });
  await loadConfig();
  paintExportPath();
  toast(saved && saved.copied
    ? `导出路径已改到 ${dir} · 当前成片已复制过去`
    : `导出路径已改到 ${dir}`);
}

$("btnReveal").onclick = () => revealOut("export");
$("btnRevealOut").onclick = () => revealOut("out");
async function revealOut(target) {
  if (!S.name) return toast("还没有成片", true);
  try {
    // 「打开文件夹」只开目录（成片交给右上角「打开成片」），
    // 「打开成片」打开正在预览的那一版，不是永远最新版
    const r = await postJSON("/api/reveal", { name: S.name, target, v: S.viewVer || 0 });
    if (r.mode === "dir" && target !== "export") toast("成片还没进导出目录，先打开了工程目录", true);
    else toast(target === "export" ? "已打开导出文件夹" : `已用默认播放器打开 v${S.viewVer || "?"}`);
  } catch (e) {
    // 打不开时别只说"失败"——顺手拉一次自检，把最可能的原因一起告诉用户
    toast(e.message, true);
    try {
      const d = await api("/api/diag");
      const p = [];
      if (d.exportDir && d.exportDir.fallback) p.push(`导出目录回退到 ${d.exportDir.dir}`);
      if (d.exportDir && d.exportDir.wantedDriveOk === false) p.push(`.env 里的盘符在本机不存在`);
      if (d.tools && d.tools.powershell && !d.tools.powershell.ok) p.push("PowerShell 不可用");
      if (d.tools && d.tools.ffmpeg && !d.tools.ffmpeg.ok) p.push("ffmpeg 不在 PATH");
      if (p.length) toast("自检：" + p.join("；"), true);
    } catch {}
  }
}

// ───────────────────────── 启动 ─────────────────────────
async function restore(name) {
  if (!name) return;
  S.name = name;
  S.gapMode = gapOf(name);   // 这条素材上次选的气口标准（重试/补跑沿用它）
  const it = (S.projects || []).find((p) => p.name === name);
  $("fName").textContent = it ? it.title : prettyName(name);
  $("fileCard").hidden = false;
  try {
    const st = await api(`/api/state?name=${encodeURIComponent(name)}`);
    paintState(st);
    if (S.logOpen) await loadFullLogs();
    if (st.input) S.file = st.input;
    if (st.vertical != null && !st.outDur) $("fMeta").innerHTML = `<i class="tag">${st.vertical ? "竖屏" : "横屏"}</i>${(st.dur || 0).toFixed(1)}s`;
    if (st.outDur) $("fMeta").innerHTML = `<i class="tag">已裁剪</i>${st.outDur.toFixed(1)}s 成片${st.curVer ? ` · v${st.curVer}` : ""}`;
    if (st.running) { S.running = true; S.mode = st.mode || "cut"; pollStart(); return; }
    // 上传了但第一轮还没开始（attempts=0）→ 停在「待选择气口标准」，并把弹窗再问一次。
    // 不再自动开跑：标准要用户自己定；刷新/切素材回来时自动弹一次，之后就靠文件卡里的按钮。
    // 跑过却仍然 idle（没有 cut-plan）= 上次失败，只给「重试」，不在刷新时无限重跑。
    if (st.idle) {
      S.versions = []; S.curVer = 0; S.viewVer = 0;
      paintVersions();
      setStep("upload");
      ensurePreview();
      if (st.attempts > 0 || st.error) {
        setStatus(st.stage || "上次处理失败", "● 失败", "warn");
        $("btnRetry").hidden = false;
        S.awaitStart = false;
        paintStartBtn();
      } else {
        S.awaitStart = true;
        paintStartBtn();
        setStatus("待选择气口标准", "● 待开始", "warn");
        if (!S.gapAsked.has(name)) {
          S.gapAsked.add(name);
          openGapModal();
        }
      }
      return;
    }
    if (st.exitCode === 0 || st.done) {
      await loadTimeline();
      setSrc("out", true);
      setStatus(st.mode === "reexport" ? "重剪完成" : "待审核", "● 就绪", "ok");
    } else if (st.exitCode) {
      setStatus("失败", "● 失败", "warn");
      $("btnRetry").hidden = false;
    }
  } catch (e) { /* 没有这个任务就留在初始态 */ }
}

(async function boot() {
  // 左栏折叠状态先落定再画波形：否则会先按展开宽度铺一次、折叠后再重铺一遍
  setLeftFolded(localStorage.getItem(LEFT_FOLD_KEY) === "1", false);
  paintWave();
  // 界面偏好：倍速与日志展开状态跨刷新保留
  setRate(Number(localStorage.getItem("studio.rate")) || 1, true);
  S.logOpen = localStorage.getItem("studio.logOpen") === "1";
  paintLogOpen();
  try { await loadConfig(); } catch (e) { toast("读配置失败：" + e.message, true); }
  await loadProjects();
  const q = new URLSearchParams(location.search).get("name");
  const saved = localStorage.getItem("studio.name");
  // 优先 URL 指定 → 其次上次打开的 → 最后取列表里最新的一条
  const pick = [q, saved].find((n) => n && S.projects.some((p) => p.name === n))
    || (S.projects[0] && S.projects[0].name);
  if (pick) await restore(pick);
})();
