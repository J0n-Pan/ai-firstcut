// 初剪引擎 —— 原片进，带动效的初剪工程出
// 用法: node firstcut/run.mjs <原片.mp4> [--name 工程名] [--speed 1.2] [--no-ai] [--no-retake] [--retake-sim 0.8] [--cut-only] [--tight-breath]
//   --cut-only: 只跑剪辑层（探测 → 气口 → 四处剪点 → 收紧气口(可选) → 剪切转码），出 cam-*.mp4 就退出，
//               跳过成片转写/错字纠错/字幕卡/AI 初剪/预览页。用于"只验收剪辑效果"的迭代。
//   --tight-breath: 收紧气口。在常规气口检测之上再跑逐帧能量掩膜，把段内/段首尾的换气全部剪掉
//               （剪辑台「收紧气口」按钮走同一个开关，服务端注入 XUNJIAN_TIGHT_BREATH=1）。
// 流程: 探测(含旋转) → 剪气口 → 剪重说口误 → 收紧气口(可选) → 提速 → 响度归一 → 转写字幕 → AI 初剪(可选) → 生成预览 → 去编辑器定剪
// 参数真源: firstcut/rules.json（覆盖优先级 CLI > 环境变量 XUNJIAN_* > rules.json > 内置默认）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectRetakes, detectStutters, detectFillers, findTier2, subtractRanges, retakeSuffixOk, detectMidRestarts, applyMidRestartVerdict, detectShortResidues, detectTailHeadRestarts, detectPrefixRestarts } from "./retake.mjs";
import { clipReviewItems, applyDecisions } from "./review-clip.mjs";
import { homeOf } from "./home.mjs";
import { resolveFf, explainFfFailure } from "./ffbin.mjs";
import { buildCutFilter, snapSegs, trimCutsToVoice } from "./cutfilters.mjs";
import { tightenFile } from "./tight-breath.mjs";
import { envelopeFor, squeezeSeams } from "./edge-snap.mjs";
import { detectDangling, clauseRanges } from "./dangling.mjs";
import { detectQuestionHeadFrags, detectQuestionPrefixRestarts, looksLikeAsk } from "./question-cut.mjs";
import { buildSplitView } from "./segview.mjs";
import { detectHeadFrags } from "./headfrag.mjs";
import { detectOpenSlate } from "./openslate.mjs";
import { decodeEnvelope, rangeStats, pickSpeechRef, classifyLowLevel, classifySilentGap } from "./speechmask.mjs";
import { detectAskChains } from "./askchain.mjs";
import { detectMetaTalk, detectIsolated } from "./metatalk.mjs";
import { subtract } from "./review-clip.mjs";
import { auditResiduals, coverageReport } from "./residue-audit.mjs";
import { beginUsage, noteAsr, finishUsage, guardExit } from "./usage.mjs";

const ROOT = process.cwd();
// 程序目录（ROOT）会被整体替换，工程数据在 HOME；两者在源码仓库里是同一个目录
const HOME = homeOf(ROOT);

// ── 零依赖 .env 加载（必须在读取任何 process.env 之前执行）──
// 项目原本没有 dotenv 机制：用户按 README 写了 .env 也不会生效，表现为"配了 key 还说没配"。
// 规则：已存在的同名环境变量优先（不覆盖用户在 shell 里显式设置的值）。
//
// 查找顺序：HOME/.env → ROOT/.env。
// 源码仓库里 HOME 与 ROOT 本来就是同一个目录，但 XUNJIAN_HOME 会把 HOME 指到别处
// （自动化测试、服务器部署）。那种情况下 HOME/.env 通常不存在，若不回退到程序目录，
// 用户明明在 ai-xunjian/.env 配了 DASHSCOPE_API_KEY 也会被判成 local —— 症状就是
// 「配了 key 却走本地 whisper，转写费用 ¥0.0000，卡壳判据用错分支」。
// 只回退、不覆盖：HOME/.env 存在时以它为准（允许不同工程用不同 key）。
(() => {
  const pick = () => {
    const a = path.join(HOME, ".env");
    if (fs.existsSync(a)) return a;
    const b = path.join(ROOT, ".env");
    if (String(ROOT) !== String(HOME) && fs.existsSync(b)) return b;
    return null;
  };
  const p = pick();
  if (!p) return;
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    console.error(`  ⚠️ .env 解析失败（已忽略）: ${e.message}`);
  }
})();

// ffmpeg/ffprobe 定位：XUNJIAN_FFMPEG（存在才用）→ 程序目录 runtime/ffmpeg → PATH。
// 不能只认环境变量：launch.vbs 没跑起来时变量不存在，安装包自带的 ffprobe 就白带了，
// 报错还只是「请确认已安装 ffmpeg」。详见 firstcut/ffbin.mjs 顶部说明。
const FF = resolveFf({ root: ROOT });
const FFMPEG = FF.ffmpeg;
const FFPROBE = FF.ffprobe;

// uv 兜底解析：从某些 shell（CI、IDE 内置终端、非登录 shell）启动时 PATH 里没有 ~/.local/bin，
// 而 uv 默认就装在那里 —— 此时 spawnSync("uv") 会 ENOENT，表现为**整条 ASR 静默失败**
// （日志只留一句"⚠️ 转写失败"、成片没字幕，看起来像模型下载问题，极难排查）。
// 这里显式去找常见安装位置，找到就用绝对路径。
const UV = (() => {
  if (process.env.XUNJIAN_UV) return process.env.XUNJIAN_UV;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cands = [path.join(home, ".local", "bin", "uv.exe"), path.join(home, ".local", "bin", "uv")];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return "uv";   // 最后回退 PATH（找不到时由调用方打印可读错误）
})();
// LLM 调用层：默认走阿里云百炼 OpenAI 兼容端点 + qwen3.5-plus，
// 与云端 ASR 共用同一个 DASHSCOPE_API_KEY —— 开源用户只需配一行。
// 想换厂商：设 XUNJIAN_LLM_BASE / XUNJIAN_LLM_MODEL 或用 rules.llm，代码不用动。
const LLM_JS = path.join(ROOT, "firstcut", "llm.mjs");

// ── rules.json：全流程参数真源 ──
// 覆盖优先级: CLI > 环境变量 XUNJIAN_* > rules.json > 内置默认(下面这份)。
// 缺文件/缺字段一律回落到内置默认,不报错退出(旧环境零改动可用)。
const DEFAULT_RULES = {
  silence: { noiseOffsetDb: -6, noiseClampDb: [-45, -25], noiseFallbackDb: -30, minSilenceSec: 0.35, edgePadSec: 0.1, minSilenceRatio: 0.05, relaxStepDb: 3, relaxMaxTries: 4, keepGapSec: 0.2, minSpeechTotalSec: 1.0 },
  segment: { minKeptSec: 0.25, pauseMinSec: 0.05, edgeFragMinRealSec: 0.8, snap: { fineSilenceSec: 0.15, searchNextWithinSec: 1.5, tailProtectSec: 0.06, insideToleranceSec: 0.05, fineTailPadSec: 0.02, speechGuardSec: 0.08 }, edgeFadeSec: 0.03 },
  // 拆段：把 ASR 句段按真实停顿再切成语义单元（详见 segview.mjs）。
  // 只影响语义通道的送审粒度；结构类检测器仍吃原始句段。关闭：XUNJIAN_SPLIT=off
  split: { enabled: true, minPauseSec: 0.35, minHeadChars: 3, minTailChars: 3, minSilenceSec: 0.1, fineSilenceSec: 0.1, wordBoundary: true },
  retake: { sim: 0.8, recallSim: 0.6, recallGapSec: 20, recallLookAhead: 8, maxGapSec: 8, minChars: 5, lookAheadSegs: 3, prefixSimMin: 0.85, lcpMin: 6, lcpGapSec: 2.0, dupSim: 0.9, dupGapSec: 20, breatheSec: 0.05, minCutSec: 0.3, mergeGapSec: 0.1, minRemainSec: 0.2 },
  stutter: { longWordSec: 1.0, cpsThreshold: 3.5, minSegSec: 1.5, minChars: 4, minCutSec: 0.5, minRepeatChars: 5, maxHeadChars: 12, innerMinChars: 14, innerMaxCutSec: 3.0, tailMinChars: 8, leadRestart: true, leadMaxChars: 6, leadPauseSec: 0.30, leadMaxCutSec: 2.5 },
  filler: { enabled: true, tier1: ["嗯", "呃", "唉", "哎", "哎呀", "哦", "噢"], tier2: [], tier1Cut: true, tier2Llm: true, standalonePauseSec: 0.12, maxDurSec: 0.6, minCutSec: 0.15 },
  corrections: { enabled: false, maxDeltaRatio: 0.3, maxEditPerLine: 8, pinyinSimMin: 0.5, chunkSize: 6 },
  asr: { provider: "auto", model: "small", beamSize: 5, vadMinSilenceMs: 300, language: "zh", hotwordsOffForRaw: true, chunkSec: 20.0, chunkOverlapSec: 0.5, coverageGapSec: 2.5, chunkRetry: 3, speechRms: 0.012, minCharsPerSec: 1.2, densityMinSpanSec: 2.5, refineChunkSec: 6.0, t2s: true, cloud: { model: "paraformer-v2", pricePerSec: 0.00008, onFail: "abort", retries: 3 } },
  caption: { maxCharsPerLine: 14, spaceBreakMinChars: 8, layout: "sentence", stripPunct: "", fixes: [] },
  encode: { speed: 1.2, crf: 18, preset: "fast", gopFrames: 15, audioBitrate: "192k", loudnorm: "I=-14:TP=-1.5:LRA=11" },
  llm: { enabled: true, model: "qwen3.5-plus", maxTokens: 8192, thinking: false, timeoutMs: 900000 },
  redundancy: { enabled: true, maxRatio: 0.35, maxRun: 6, maxSegSec: 20, slipMaxChars: 16, paraphraseGapSec: 25, paraphraseMinChars: 8, paraphraseMinSec: 1.5, offtopicHeadSegs: 2, offtopicTailSegs: 2 },
  arbiter: { enabled: true, kinds: ["caption-break"], model: "qwen3.5-plus", fallbackToAlgo: true, maxDeltaRatio: 0.3, minConfidence: 0.6, onUnknownId: "ignore", onMissingId: "algo" },
  // 收紧气口（「收紧气口」按钮 / --tight-breath）：逐帧能量掩膜，判据见 tight-breath.mjs 顶部
  tightBreath: { refDb: 18, guardSec: 0.05, minRunSec: 0.06, minPieceSec: 0.02, maxShrinkRatio: 0.55 },
};
const deepMerge = (base, over) => {
  if (Array.isArray(over) || over === null || typeof over !== "object") return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
};
const RULES_PATH = process.env.XUNJIAN_RULES || path.join(ROOT, "firstcut", "rules.json");
let R = DEFAULT_RULES;
try {
  R = deepMerge(DEFAULT_RULES, JSON.parse(fs.readFileSync(RULES_PATH, "utf8")));
} catch (e) {
  console.error(`  ⚠️ 未读到 rules.json(${RULES_PATH})，使用内置默认: ${e.message}`);
}

// 模型名唯一解析点：XUNJIAN_LLM_MODEL > rules.json llm.model > 内置默认。
// 历史坑：裁决点曾把 R.llm.model 直接传给子进程，把环境变量静默覆盖掉 —— 文档写着
// 「环境变量优先于 rules.json」，换模型做 A/B 时却表现为"换了没变"，白跑一整轮。
const LLM_MODEL = process.env.XUNJIAN_LLM_MODEL || (R.llm && R.llm.model) || "qwen3.5-plus";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input || !fs.existsSync(input)) {
  console.error("用法: node firstcut/run.mjs <原片.mp4> [--name 工程名] [--speed 1.2] [--no-ai]");
  process.exit(1);
}
const getOpt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const NAME = getOpt("--name", path.basename(input).replace(/\.[^.]+$/, "").replace(/[^\w一-龥-]/g, "-"));
const SPEED = Number(getOpt("--speed", String(R.encode.speed)));
const NO_AI = args.includes("--no-ai");
const NO_RETAKE = args.includes("--no-retake");
const NO_AICUT = args.includes("--no-aicut");   // 只跳过 AI 初剪，保留断行裁决（P1 单独测试用）
const CUT_ONLY = args.includes("--cut-only");   // 只跑剪辑层，出成片即止（不做字幕/初剪/预览页）
// 收紧气口：两个入口都注入 XUNJIAN_TIGHT_BREATH=1 ——
//   ① 上传后的「选择气口处理标准」选了「收紧」→ 首轮就带；
//   ② 剪辑台顶栏「收紧气口」→ 对原片再跑一轮。
// 语义是「在常规气口检测之上，再把所有还可能听出换气的残余剪干净」，判据见 tight-breath.mjs。
const TIGHT = args.includes("--tight-breath") ||
  /^(1|true|on|yes)$/i.test(String(process.env.XUNJIAN_TIGHT_BREATH || ""));
// 「收紧气口」重跑：服务端先把旧版冻结成 vN，再传这个号让本次结果登记为第 N 版
const REBASE_TO = Number(process.env.XUNJIAN_REBASE_TO || 0);
const RETAKE_SIM_OPT = getOpt("--retake-sim", null);   // 未显式给出时用 rules.retake.sim
const EP = path.join(HOME, "episodes", NAME);
const step = (m) => console.log("\n▸ " + m);

// ── 记账：这一轮到底花了多少钱 ──
// 四个裁决点都是 spawn llm.mjs，子进程各自把 usage 追加到 XUNJIAN_USAGE_LOG（这里指到
// work/llm-usage.jsonl）；云端转写在 stdout 打 ASR_USAGE 账单行，由 noteAsr 收集。
// 收尾汇总成 work/run-usage.json，服务端 /api/cost 原样给前端。记账失败不影响剪辑。
const USAGE = beginUsage(EP, {
  rules: R,
  model: LLM_MODEL,
  version: REBASE_TO || 1,
  mode: REBASE_TO ? "rebase" : "cut",
});
guardExit(USAGE);
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 64e6, ...opts });
const die = (m) => { console.error("✗ " + m); process.exit(1); };
// 转写子进程环境:离线/代理环境下 huggingface_hub 会去校验模型 etag,走代理常被 502 拦掉,
// 导致 ASR 整链静默降级为"无字幕"(且误导性提示"需安装 uv")。这里给 uv 子进程兜底默认:
// 走 hf-mirror 镜像 + 关 xet/软链接。用户若已显式设置同名变量则不覆盖。
const ASR_ENV = {
  ...process.env,
  HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
  HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || "1",
  HF_HUB_DISABLE_SYMLINKS: process.env.HF_HUB_DISABLE_SYMLINKS || "1",
  // uv 每次 run 默认会去索引校验依赖，本机走代理经常 502/长时间挂住（实测 C0793 卡 19 分钟无进展）。
  // 依赖（faster-whisper / av / jieba / zhconv）首次跑过后已在 uv 缓存里，默认离线即可；
  // 换机器首次使用请设 UV_OFFLINE=0 让 uv 联网装包。
  UV_OFFLINE: process.env.UV_OFFLINE || "1",
  // 模型已在本地缓存时仍会走一次 hub API（etag 校验），本机代理 502 会让整条转写失败
  // （实测 v7b-C0793：httpx2.ProxyError: 502 → 无字幕/无剪点）。默认直接禁止 hub 联网，
  // 失败时 runAsr 会自动联网重试一次（首次使用/换机器场景）。
  HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || "1",
};
// ASR 调用统一走这里:失败时把 stderr 尾巴打进日志,避免"转写不可用"变成无信息的黑洞。
const asrFail = (r) => {
  const txt = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ");
  if (txt) return txt;
  // spawnSync 自身失败（ENOENT/超时）时 stderr 是空的，真正的错因在 r.error —— 不打印出来
  // 就会变成一句无信息的"转写失败"，让人误以为是模型/网络问题。
  if (r.error) return `${r.error.code || r.error.name}: ${r.error.message}`;
  return `exit=${r.status}${r.signal ? " signal=" + r.signal : ""}（无输出）`;
};
// 转写统一入口：默认离线跑；命中网络/代理类错误时自动联网重试一次（模型未缓存的新机器也能过）
const runAsr = (argv, extraEnv = {}) => {
  let r = run(UV, argv, { env: { ...ASR_ENV, ...extraEnv } });
  const msg = `${r.stderr || ""}${r.stdout || ""}`;
  if (r.status !== 0 && /502|ProxyError|Connection|ConnectError|timed out|offline|couldn't connect/i.test(msg)) {
    console.log("  ↻ 转写遇网络/代理错误，改用联网模式重试一次");
    r = run(UV, argv, { env: { ...ASR_ENV, ...extraEnv, HF_HUB_OFFLINE: "0", UV_OFFLINE: "0" } });
  }
  return r;
};

// ── ASR provider 调度 ────────────────────────────────────────────────────────
// cloud: paraformer-v2 文件转写（真实字级时间戳，无需本地模型）
// local: faster-whisper（离线兜底；开源用户没有 key 时仍能跑）
// auto : 有 DASHSCOPE_API_KEY 就走云端，否则本地
const ASR_PROVIDER = (() => {
  const v = String(process.env.XUNJIAN_ASR_PROVIDER || (R.asr && R.asr.provider) || "auto").toLowerCase();
  if (v === "cloud" || v === "local") return v;
  return (process.env.DASHSCOPE_API_KEY || "").trim() ? "cloud" : "local";
})();
// 云端转写只依赖 dashscope + requests。若用户已装好（或指定了解释器）就直接跑，
// 否则交给 uv 托管（与 local 一致的"零手动安装"体验）。
const PY_DIRECT = (process.env.XUNJIAN_PYTHON || "").trim();
const runPy = (argv, extraEnv = {}) => {
  if (PY_DIRECT) return run(PY_DIRECT, argv, { env: { ...process.env, ...extraEnv } });
  // 注意：不能带 UV_OFFLINE=1。它是给 whisper 那颗"依赖已在缓存里"的场景兜底的，
  // 而云端首次跑必须联网装 dashscope/requests（实测首次 ~25s，之后命中缓存 ~1s）。
  const env = { ...ASR_ENV, ...extraEnv };
  delete env.UV_OFFLINE;
  env.HF_HUB_OFFLINE = "0";
  return run(UV, ["run", "--with", "dashscope", "--with", "requests", "python", ...argv], { env });
};

/** 原片转写（结构用途：重说/卡壳/语气词判据的输入）→ 句段 IR 落盘 */
const transcribeRaw = (wav, segsOut, extraEnv = {}) => {
  if (ASR_PROVIDER === "cloud") {
    return runPy([path.join(ROOT, "firstcut/asr_cloud.py"), wav, segsOut], extraEnv);
  }
  const capsOut = path.join(EP, "work/raw-caps.json");
  return runAsr(["run", "--with", "faster-whisper", "--with", "av<14", "--with", "jieba", "--with", "zhconv", "python",
    path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut,
    process.env.XUNJIAN_WHISPER_MODEL || R.asr.model, segsOut], extraEnv);
};

/** 成片字幕转写。cloud 下复用同一份云端结果走本地断行，不再二次计费。 */
// 字幕断行（replay 模式）需要 numpy 读音频算停顿、jieba 算词边界、zhconv 繁转简；
// 少了 numpy 会静默退化成"只按词边界断行"（日志会打"读不到音频"），断行质量明显下降。
const runCapsPy = (argv, extraEnv = {}) => {
  if (PY_DIRECT) return run(PY_DIRECT, argv, { env: { ...process.env, ...extraEnv } });
  const env = { ...ASR_ENV, ...extraEnv };
  delete env.UV_OFFLINE;
  env.HF_HUB_OFFLINE = "0";
  return run(UV, ["run", "--with", "numpy", "--with", "jieba", "--with", "zhconv", "python", ...argv], { env });
};
const transcribeCaps = (wav, capsOut, segsOut) => {
  if (ASR_PROVIDER === "cloud") {
    const r1 = runPy([path.join(ROOT, "firstcut/asr_cloud.py"), wav, segsOut], {});
    noteAsr(USAGE, r1.stdout);   // 这一趟是单独计费的，账单不能漏
    if (r1.status !== 0) return r1;
    // asr_and_caps.py 内建的 replay 入口：从句段 JSON 重建字幕，跳过 whisper。
    return runCapsPy([path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut], { XUNJIAN_BREAK_FROM_SEGS: segsOut });
  }
  return runAsr(["run", "--with", "faster-whisper", "--with", "av<14", "--with", "jieba", "--with", "zhconv", "python",
    path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut], { XUNJIAN_ASR_HOTWORDS: "off" });
};

// ── 统一语义裁决(arbiter)──
// 读 firstcut/arbiter-prompt-<kind>.md,把 payload 填进 {{INPUT}},调 LLM 取 JSON。
// LLM 只给"表态/建议",最终由确定性代码落地;任何失败返回 null,调用方回退算法结果。
const arbiterOk = (kind) => !NO_AI && R.arbiter.enabled && (R.arbiter.kinds || []).includes(kind);

// 底层调用：提示词走 stdin，模型原文走 stdout。所有走模型的地方都必须经过这里。
// 历史坑：字幕断行裁决 / AI 初剪两处原来写的是 runCli(LLM, ["-p", ...])，
// 指向早已移除的 claude CLI，且 LLM 这个变量本身也一并删了 —— 一旦触发必然
// ReferenceError 崩掉整个流程。带 --no-ai 的跑批永远不会走到，所以潜伏了很久。
const llmText = (prompt, tag, model) => spawnSync(process.execPath, [LLM_JS], {
  encoding: "utf8", maxBuffer: 64e6, input: prompt, timeout: R.llm.timeoutMs,
  env: {
    ...process.env, XUNJIAN_USAGE_TAG: tag,
    ...((model || LLM_MODEL) ? { XUNJIAN_LLM_MODEL: model || LLM_MODEL } : {}),
  },
});

const adjudicate = (kind, payload) => {
  const pf = path.join(ROOT, `firstcut/arbiter-prompt-${kind}.md`);
  if (!fs.existsSync(pf)) { console.log(`  ⚠️ 缺少 arbiter-prompt-${kind}.md，跳过裁决`); return null; }
  let prompt = fs.readFileSync(pf, "utf8").replaceAll("{{INPUT}}", JSON.stringify(payload));
  // 直接 spawn node（不再经 shell 拼命令行）：Windows 上省掉整套引号转义，也避免
  // 用户机器上 claude.cmd 之类的 PATH 依赖。提示词走 stdin，结果走 stdout。
  const ax = llmText(prompt, kind, LLM_MODEL);
  const ao = ax.stdout || "";
  if (ax.status !== 0 && !ao.trim()) {
    const why = (ax.stderr || "").trim().split("\n").slice(-2).join(" | ") || ax.error?.message || "无输出";
    console.log(`  ⚠️ ${kind} 裁决调用失败（${why}），回退算法结果`);
    return null;
  }
  try { return JSON.parse(ao.slice(ao.indexOf("{"), ao.lastIndexOf("}") + 1)); }
  catch { console.log(`  ⚠️ ${kind} 裁决解析失败，回退算法结果: ${ao.trim().slice(0, 100)}`); return null; }
};
// 编辑距离(错字纠错的护栏:改动幅度过大视为"改写"而丢弃)
const lev = (a, b) => {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
};

// ── 1. 探测（旋转元数据决定横竖）──
step("探测原片");
const probe = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries",
  "stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration", "-of", "json", input]);
if (probe.status !== 0) {
  // 报错必须能自证：找的是哪个 ffprobe、它在不在、输入在不在、它自己说了什么。
  // 1.1.5 装机实测过「只说请确认已安装 ffmpeg」，用户和我们都无从下手。
  console.error("✗ ffprobe 失败");
  for (const line of explainFfFailure(FF, { input, r: probe })) console.error("  " + line);
  process.exit(1);
}
const pj = JSON.parse(probe.stdout);
const st = pj.streams?.[0] || {};
// 帧率用来把段边界吸附到帧网格（cutfilters.snapSegs）：剪点越多，音视频各自取整的
// 累计误差越大 —— 93 段时不吸附会差 0.7s，口型对不上。
const FPS = (() => {
  const raw = String(st.r_frame_rate || st.avg_frame_rate || "");
  const [a, b] = raw.split("/").map(Number);
  const v = b ? a / b : Number(raw);
  return Number.isFinite(v) && v > 1 ? +v.toFixed(3) : 0;
})();
const rot = Math.abs(Number((st.side_data_list || []).find((d) => d.rotation != null)?.rotation || 0));
const vertical = rot === 90 || rot === 270 ? st.width > st.height : st.height > st.width;
const rawDur = Number(pj.format?.duration || 0);
console.log(`  ${st.width}x${st.height} rotation=${rot} → ${vertical ? "竖屏 ✓" : "⚠️ 横屏(编辑器默认竖屏版式,建议竖屏素材)"} · ${rawDur.toFixed(1)}s · ${FPS || "?"}fps`);

// ── 审核队列（供剪辑台逐条问用户）──
// 只收「模型表了态、却被确定性护栏推翻」的冲突点；"判据压根没命中"的漏检不进队列，
// 否则队列会被噪音塞满。options 用**区间集合**表达（删一个词 / 删整句 / 删前半），
// 而不是布尔值 —— 重导出时直接按区间从 segs 里减掉即可，不必回头问模型。
// 去标点/空白，只留汉字字母数字。卡片文案与日志用（与 704 行局部的 _nz 同义，
// 提成全局是因为 2.7/2.8 在块外也要用）。
const nzText = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
const REVIEW = [];
const pushReview = (o) => REVIEW.push({ id: REVIEW.length + 1, default: "keep", priority: 2, ...o });

// ── 2. 剪气口（静音检测 → trim/concat）──
step("检测气口/无声段");
// 噪声门自适应:不同素材整体音量差异极大(直播间素材实测均值可低至 -28dB),
// 固定 -38dB 在低音量素材上几乎测不出静音 → 以实测平均音量再加 noiseOffsetDb 作阈值,
// 并夹在 noiseClampDb 区间;可用 XUNJIAN_NOISE_DB / XUNJIAN_SIL_D / XUNJIAN_PAD 覆盖。
//
// 单靠均值仍会失手:实测「课堂实拍」素材(人声轻 −34.9dB + 连续底噪)下 mean−6=−41dB
// 落在实际停顿电平之下,全片 0 处静音 → 气口一刀未剪。故加一层**反馈式放宽**:
// 先按 mean−6 试,若检出静音总时长不足 minSilenceRatio,每次放宽 relaxStepDb(最多 relaxMaxTries 次),取首次达标者。
// 这三处「全片分析」只吃音频，必须带 -vn 跳过视频解码。
// 实测（1080×1920 59.94、6 核）：30s 素材 silencedetect 全解码 3781ms → 加 -vn 548ms，**6.9×**；
// 而一次剪辑要跑最多 7 遍（音量 1 + 气口 1+4 次放宽 + 切口吸附 1），4K/HEVC 源差距还要大得多。
const vd = run(FFMPEG, ["-i", input, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
const meanDb = Number((/mean_volume:\s*(-?[\d.]+) dB/.exec(vd.stderr || "") || [])[1]);
const [NMIN, NMAX] = R.silence.noiseClampDb;
const baseNoise = Number(process.env.XUNJIAN_NOISE_DB) ||
  (Number.isFinite(meanDb) ? Math.round(Math.max(NMIN, Math.min(NMAX, meanDb + R.silence.noiseOffsetDb))) : R.silence.noiseFallbackDb);
const SIL_D = Number(process.env.XUNJIAN_SIL_D) || R.silence.minSilenceSec;
const PAD = Number(process.env.XUNJIAN_PAD) || R.silence.edgePadSec;
const silLog = (db) => (run(FFMPEG, ["-i", input, "-vn", "-af",
  `silencedetect=noise=${db}dB:d=${SIL_D}`, "-f", "null", "-"]).stderr || "");
const silTotal = (l) => [...l.matchAll(/silence_duration: ([\d.]+)/g)]
  .reduce((a, m) => a + Number(m[1]), 0);
let NOISE = baseNoise, log = silLog(NOISE);
const MIN_SIL = rawDur * R.silence.minSilenceRatio;   // 期望至少这么多时长为停顿,否则判定门限过严
if (!Number(process.env.XUNJIAN_NOISE_DB) && silTotal(log) < MIN_SIL) {
  for (let k = 1; k <= R.silence.relaxMaxTries; k++) {
    const cand = baseNoise + R.silence.relaxStepDb * k;      // 抬高门限(更宽松)才能检出更多停顿
    const l2 = silLog(cand);
    if (silTotal(l2) >= MIN_SIL) {
      console.log(`  噪声门放宽 ${baseNoise}→${cand}dB(原门限仅检出 ${silTotal(log).toFixed(1)}s 停顿 < 全片 ${(R.silence.minSilenceRatio * 100).toFixed(0)}%)`);
      NOISE = cand; log = l2; break;
    }
  }
}
console.log(`  噪声门 ${NOISE}dB(原片均值 ${Number.isFinite(meanDb) ? meanDb.toFixed(1) : "?"}dB) · 最短静音 ${SIL_D}s · 边界内缩 ${PAD}s`);
const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
let segs = [], cur = 0;
for (let i = 0; i < starts.length; i++) {
  const s0 = Math.min(starts[i] + PAD, rawDur), e0 = Math.max((ends[i] ?? rawDur) - PAD, 0);
  if (s0 - cur > R.silence.keepGapSec) segs.push([cur, s0]);
  cur = Math.max(cur, e0);
}
if (rawDur - cur > R.silence.keepGapSec) segs.push([cur, rawDur]);
if (!segs.length || segs.reduce((a, [s, e]) => a + e - s, 0) < R.silence.minSpeechTotalSec) { segs = [[0, rawDur]]; console.log("  几乎无有效人声分段，保留全片"); }
else console.log(`  保留 ${segs.length} 段，剪掉 ${(rawDur - segs.reduce((a, [s, e]) => a + e - s, 0)).toFixed(1)}s 气口`);

// ── 首尾孤立短碎片过滤 ──
// 实测：C0793 片头只留下 [7.33-7.63] 0.30s、[16.56-16.93] 0.37s 两个碎片（之后到 38.27s 才是正文）；
// C0777 片头同样有 [18.53-18.79] 0.26s、[19.11-19.41] 0.30s —— 听感就是"开头一直有杂音"。
// 判据不靠绝对时长，而是「落在正文范围之外」：找到第一条/最后一条 ≥ minRealSec 的段，
// 它之前（片尾则是之后）的短段一律丢弃。正文中间出现的短句（"对。"）不受影响。
const dropEdgeFrags = (list) => {
  const MINREAL = Number(process.env.XUNJIAN_MINREAL ?? R.segment.edgeFragMinRealSec ?? 0.8);
  const isReal = ([s, e]) => e - s >= MINREAL;
  const fi = list.findIndex(isReal);
  let li = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isReal(list[i])) { li = i; break; }
  if (fi < 0 || li < 0) return { list, dropped: [] };
  const dropped = [], kept = [];
  list.forEach((sg, i) => {
    if ((i < fi || i > li) && !isReal(sg)) dropped.push(sg);
    else kept.push(sg);
  });
  return { list: kept, dropped };
};
const _ef = dropEdgeFrags(segs);
if (_ef.dropped.length) {
  segs = _ef.list;
  console.log(`  丢弃首尾孤立短碎片 ${_ef.dropped.length} 处（判为碰麦/呼吸/桌面噪声）：` +
    _ef.dropped.map(([s, e]) => `[${s.toFixed(2)}-${e.toFixed(2)}]`).join(" "));
}

// ── 2.5 剪重说口误（转写原片 → 紧挨着的高相似句 = 说错重来，剪前一遍保后一遍）──
let cutsGlobal = [];   // 供 cut-plan.json 落盘（重说/卡壳的实际切口）
let PRE_HANDLED_SRC = new Set();  // 已被 2.6~2.8 处理过的 rawSegs 下标：语义层不再重复判、不重复出卡
let LOWLEVEL_CUTS = [];          // 2.6~2.8 产生的整段切口（1913 行 cutsGlobal 被重赋值，需单独留存后补）
let SPEECH_INFO = null;
let ASKCHAIN_INFO = null;
let METATALK_INFO = null;
let RAW_SEGS = [];     // 原片逐句转写，供剪后「孤立残句」过滤复用
let SPLIT_UNITS = [];  // 拆段视图（语义单元）；结构类检测器仍吃 RAW_SEGS
let SPLIT_MARKS = [];  // 实际生效的切点，落盘供复核
let AUDIT_STATS = { scanned: 0, hits: 0, queued: 0 };
let DUP_HEAD = new Set();   // 「重来版」的第一句下标：它们是被重说的最终版本，不许删
let FINE_SEGS = [];    // 段级复核转写（上下文更短，短词更全）——只用于语气词候选
if (!NO_RETAKE) {
  step("检测重说口误(转写原片,约1-2分钟)");
  fs.mkdirSync(path.join(EP, "work"), { recursive: true });
  const rawWav = path.join(EP, "work/raw-asr.wav");
  const rawCaps = path.join(EP, "work/raw-caps.json");
  const rawSegsPath = path.join(EP, "work/raw-segs.json");
  run(FFMPEG, ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", rawWav]);
  // 这一步必须关掉领域热词提示:注入提示会让 whisper 把整片解码成一段连续文本、
  // VAD 分段全被合并(13 段→1 段),下游重说/卡壳检测就会空转。热词只用于成片字幕那一步。
  // 云端模式下这个顾虑不存在（paraformer 不做 initial_prompt 注入），参数保留只为兼容 local。
  //
  // 复用已有转写（XUNJIAN_REUSE_ASR=1）：调参/复跑时不必每次都重新计费。
  // 只在「raw-segs.json 与 raw-asr.wav 都比源片新」时生效 —— 换了素材文件自动失效。
  // 注意：paraformer 对同一段音频的切句并不完全稳定（实测同一份飞书素材三次跑出
  // 24 / 68 / 72 个句段），所以复跑对照时要么固定复用、要么接受分段差异。
  const _mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const reuseAsr = process.env.XUNJIAN_REUSE_ASR === "1"
    && _mt(rawSegsPath) > _mt(input) && _mt(rawWav) > _mt(input);
  let ra = { status: 0, stdout: "", stderr: "" };
  if (reuseAsr) console.log("  ⏭ 复用已有转写（XUNJIAN_REUSE_ASR=1，不再调用 ASR 计费）");
  else {
    ra = transcribeRaw(rawWav, rawSegsPath, { XUNJIAN_ASR_HOTWORDS: "off" });
    noteAsr(USAGE, ra.stdout);
  }
  if (ra.status !== 0) console.log(`  ⚠️ 原片转写失败: ${asrFail(ra)}`);
  if (ra.status === 0 && fs.existsSync(rawSegsPath)) {
    const rawSegs = RAW_SEGS = JSON.parse(fs.readFileSync(rawSegsPath, "utf8"));
    // ── 拆段视图：语义通道专用 ──
    // ASR 的句段是"按语义/标点切句"，不是按停顿。一个句段里常塞着「说错 + 重说」两遍，
    // 语义通道只能整段判 ok（读起来确实成立），结构通道又要求"重来点贴段首"→ 两边都不认领。
    // 这里按「词间停顿 + 声学静音 + 词边界 + 句法」四证切出更小的语义单元，**原始句段一律不动**：
    // 结构类检测器（段内多次起头 / 问句前缀 / 分句悬空 / 尾首重说 / 短残句）继续吃 rawSegs。
    const SP = R.split || R.segment?.split || {};
    const SPLIT_ON = process.env.XUNJIAN_SPLIT !== "off" && SP.enabled !== false;
    let SPLIT = { units: rawSegs.map((x, i) => ({ ...x, srcId: i, part: 0 })), marks: [], rejected: [], baseCount: rawSegs.length };
    if (SPLIT_ON) {
      // 声学静音：与剪辑同一个噪声门（NOISE），只把窗口放细到 d=0.10s。
      // 不能只看 ASR 的字间空隙 —— 那是强制对齐的结果，实测 34 个候选里 8 个在 ±0.3s 内没有静音。
      const sd = run(FFMPEG, ["-hide_banner", "-nostats", "-i", rawWav, "-af",
        `silencedetect=noise=${NOISE}dB:d=${SP.fineSilenceSec ?? 0.1}`, "-f", "null", "-"]);
      const sLog = sd.stderr || "";
      const ss = [...sLog.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
      const se = [...sLog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
      const silence = ss.map((s, i) => [s, se[i] ?? rawDur]);
      SPLIT = buildSplitView(rawSegs, { ...SP, silence });
      if (SPLIT.marks.length) {
        console.log(`  拆段：${rawSegs.length} 句 → ${SPLIT.units.length} 个语义单元（${SPLIT.marks.length} 个切点，均落在真实静音 + 词边界上）`);
        for (const m of SPLIT.marks) console.log(`    ⫶ #${m.srcId}@${m.t.toFixed(2)}s 停顿 ${m.gap}s`);
      }
    }
    SPLIT_UNITS = SPLIT.units; SPLIT_MARKS = SPLIT.marks;
    const SEG = SPLIT.units;   // 语义视图：句段级判据在它上面跑，整句级护栏按 srcId 回查 rawSegs

    // ── 2.6 低电平整句判废 / 无字底噪清理（D-05）────────────────────────
    // 气口与收紧气口都只看能量、不看转写，同一件事的两个方向都会出错：
    //   a) 整句压着音量说 → 被当静音剪成碎片。C0793 #8「这果免费送价值一千多万就不能说是吧？」
    //      17 个字连续覆盖 78.02–81.40，句内窗口 p90 比语音参考低 19.6dB；气口 removed 把
    //      97% 的字时长删掉，成片只剩 0.11s「就不」——用户看到的是句子被切碎，且查不出是哪一刀。
    //   b) 句尾纯底噪 → 电平刚好卡在门限上方被保留。DJI 结尾 89.23–90.63 共 1.39s、零个字、
    //      p90 比语音参考低 13.2dB，却因为 tight 门限是 ref−18dB 侥幸留下 1.4s 空白。
    //
    // 两件事的正确处理都不是「保护碎片」，而是**按整句判废、整段删干净**：
    // 用户要的是「这句不要」，不是「这句留三个字」。判废后整段从 segs 扣除，
    // 后面的 tight 与切口吸附再也碰不到它，自然不会产生碎片。
    // 这类句子不生成待确认卡片（2026-11-10 定：低电平废句直接删，不用人来拍板）。
    {
      const envPath = path.join(EP, "work/_env.pcm");
      const pe = decodeEnvelope({ ffmpeg: FFMPEG, input, outPath: envPath });
      if (pe.db.length) {
        const _w = [];
        for (const sg of rawSegs) for (const [a, b, c] of sg.w || []) _w.push({ s: +a, e: +b, c });
        const perSeg = rawSegs.map((sg, i) => ({ i, s: sg.s, e: sg.e, text: sg.z,
          ...rangeStats(pe.db, sg.s, sg.e, pe.frameSec) }));
        const ref = pickSpeechRef(perSeg);
        const SPO = R.speech || {};
        const lv = classifyLowLevel(perSeg, ref, SPO);
        const gp = classifySilentGap({ db: pe.db, segs, words: _w, dur: rawDur, ref, opt: SPO });
        // 已经在气口阶段被整段剪掉的句子，再 subtract 是空操作 —— 不要打成「删」，
        // 否则日志会让复盘的人以为这一刀是新加的（C0779 的片头试句就是这种）。
        const alive = (s0, e0) => segs.some(([a, b]) => Math.min(b, e0) - Math.max(a, s0) > 0.1);
        for (const h of lv.hits) {
          PRE_HANDLED_SRC.add(h.i);
          if (!alive(h.s, h.e)) {
            console.log(`  ↷ 低电平整句（已在气口剪除）：#${h.i}「${h.text.slice(0, 18)}」`);
            continue;
          }
          segs = subtract(segs, [h.s, h.e]);
          LOWLEVEL_CUTS.push([h.s, h.e]);
          console.log(`  ⌫ 低电平整句：删 #${h.i} ${h.dur.toFixed(2)}s（比语音参考低 ${h.dropDb}dB）「${h.text.slice(0, 18)}」`);
        }
        for (const h of gp.hits) {
          segs = subtract(segs, [h.s, h.e]);
          LOWLEVEL_CUTS.push([h.s, h.e]);
          console.log(`  ⌫ 无字底噪：删 ${h.s.toFixed(2)}–${h.e.toFixed(2)}（${h.dur}s，比语音参考低 ${h.dropDb}dB）`);
        }
        SPEECH_INFO = {
          ref: +ref.toFixed(1),
          lowlevel: lv.hits.length, silentGap: gp.hits.length,
          dropDb: SPO.dropDb ?? 15, gapSec: SPO.gapSec ?? 1.0, gapDropDb: SPO.gapDropDb ?? 12,
        };
        if (!lv.hits.length && !gp.hits.length) console.log(`  低电平/底噪判废：0 处（语音参考 ${ref.toFixed(1)}dB）`);
      } else {
        console.log(`  ⚠️ 低电平判废跳过：${pe.error || "无音频帧"}`);
      }
      try { fs.unlinkSync(envPath); } catch {}
    }

    // ── 2.7 连续同义提问（D-04）──────────────────────────────────────
    // 同一件事换着措辞问两三遍，每一句单看都通顺，模型一律判 ok（C0853 53.3–64.4s 四连问）。
    // 判据全在 askchain.mjs：两条都是问句 + 间隔 ≤2.5s + 焦点类别集合相等 + 实词重合 ≥60%。
    //   · 同义（same）  → 删前留后，不看长度。C0853 #12「你老师到底有什么方法？」被 #13 覆盖。
    //   · 相关（related）→ 只标记进卡片。C0853 #11 问的是"在哪学"，与 #12 的"有什么方法"
    //                     不是同一问，删了会丢掉 WHERE 这条信息。
    // 必须喂 rawSegs：拆段会把 #13 切成「呃老师那到底呃呃」+「老师你这个到底是什么方法呢」，
    // 两段间隔 2.59s 直接断链，正当的 #12→#13 反而漏判（已实测复现）。
    {
      const ac = detectAskChains(rawSegs, R.askChain || {});
      let sameN = 0, relN = 0;
      for (const pr of ac.pairs) {
        const a = rawSegs[pr.i], b = rawSegs[pr.j];
        if (!a || !b) continue;
        PRE_HANDLED_SRC.add(pr.i);
        if (pr.mode === "same") {
          segs = subtract(segs, [a.s, a.e]);
          LOWLEVEL_CUTS.push([a.s, a.e]);
          sameN++;
          console.log(`  ⌫ 同义问句：删前句 #${pr.i}「${nzText(a.z).slice(0, 16)}」${(a.e - a.s).toFixed(2)}s，保留 #${pr.j}「${nzText(b.z).slice(0, 16)}」`);
          pushReview({
            kind: "same-question", priority: 1, s: a.s, e: a.e, segId: pr.i,
            removedBy: "askchain", default: "cut",
            text: nzText(a.z).slice(0, 22), line: a.z,
            llm: { verdict: "cut", reason: `与后一句问的是同一件事：#${pr.j}「${nzText(b.z).slice(0, 18)}」` },
            guard: { rule: "askChain", value: `焦点 ${pr.fi.join("/") || "-"} · 实词重合 ${(pr.ratio * 100).toFixed(0)}%`, limit: "同义问句删前留后" },
            question: `这句与后一句问的是同一件事，已按「删前留后」删掉这句。需要保留吗？`,
            options: [{ label: "保留这句", cuts: [] }, { label: "确认删除", cuts: [[a.s, a.e]] }],
          });
        } else {
          relN++;
          pushReview({
            kind: "same-question-weak", priority: 2, s: a.s, e: a.e, segId: pr.i,
            text: nzText(a.z).slice(0, 22), line: a.z,
            llm: { verdict: "keep", reason: `与后一句主题相同但问的不是一件事（后句：「${nzText(b.z).slice(0, 18)}」）` },
            guard: { rule: "askChain", value: `焦点 ${pr.fi.join("/") || "-"} ≠ ${pr.fj.join("/") || "-"}`, limit: "不同意义的相邻问句只标记" },
            question: `这两句连着问、主题相同，但不是同一个问题。前一句要删吗？`,
            options: [{ label: "删除前句", cuts: [[a.s, a.e]] }, { label: "保留", cuts: [] }],
          });
        }
      }
      ASKCHAIN_INFO = { scanned: ac.report.scanned, same: sameN, related: relN };
      if (sameN || relN) console.log(`  连续问句：删 ${sameN} 句、待确认 ${relN} 句（共 ${ac.pairs.length} 对）`);
    }

    // ── 2.8 元话语 / 孤立单句（D-07）────────────────────────────────
    // 这两类句子语义通道一定判 ok（语法完整、内容通顺），但本来就不该进片：
    //   · 元话语：讲给录音键听的不是讲给观众听的。DJI #0「单独录这一条…」、
    //     C0793 #10「没关系，我就这样吧」。按位置 + 时长 + 字面无承接 + 词表判，**只进卡不自动删**。
    //   · 孤立句：离正文主体 ≥5s 的单句。C0793 #0「现在备战其中」距正文 34.5s，
    //     留着就是一段突兀残句 —— 用户 2026-11-10 定：默认删。
    {
      const mt = detectMetaTalk(rawSegs, R.metaTalk || {});
      const iso = detectIsolated(rawSegs, R.metaTalk || {});
      const seen = new Set();
      let mtN = 0, isoN = 0;
      // 顺序是有意的：**先孤立句、后元话语**。
      // 两者都命中时（C0793 #0「现在备战其中」既像录制说明、又离正文 34.5s），
      // 按「孤立句默认删」处理 —— 用户 2026-11-10 定：离正文很远的残句不留。
      for (const h of iso.hits) {
        if (seen.has(h.i)) continue;
        seen.add(h.i);
        PRE_HANDLED_SRC.add(h.i);
        const x = rawSegs[h.i];
        if (!x) continue;
        isoN++;
        const live = segs.some(([a, b]) => Math.min(b, x.e) - Math.max(a, x.s) > 0.1);
        if (live) {
          segs = subtract(segs, [x.s, x.e]);
          LOWLEVEL_CUTS.push([x.s, x.e]);
          console.log(`  ⌫ 孤立单句：删 #${h.i}「${nzText(x.z).slice(0, 16)}」${h.durSec.toFixed(2)}s（离正文 ${h.gapSec.toFixed(1)}s）`);
        } else {
          console.log(`  ↷ 孤立单句（已在气口剪除）：#${h.i}「${nzText(x.z).slice(0, 16)}」离正文 ${h.gapSec.toFixed(1)}s`);
        }
        pushReview({
          kind: "isolated", priority: 1, s: x.s, e: x.e, segId: h.i,
          removedBy: "isolated", default: "cut",
          text: nzText(x.z).slice(0, 22), line: x.z,
          llm: { verdict: "cut", reason: `离正文主体 ${h.gapSec.toFixed(1)}s，是一句孤立的${h.side === "pre" ? "片头" : "片尾"}残句` },
          guard: { rule: "isolatedSeg", value: `距主体 ${h.gapSec.toFixed(1)}s · 自身 ${h.durSec.toFixed(2)}s`, limit: "默认删，可恢复" },
          question: `这句离正文有 ${h.gapSec.toFixed(1)}s 远，孤零零一句。已按默认删掉，需要保留吗？`,
          options: [{ label: "保留这句", cuts: [] }, { label: "确认删除", cuts: [[x.s, x.e]] }],
        });
      }
      for (const h of mt.hits) {
        if (seen.has(h.i)) continue;
        seen.add(h.i);
        PRE_HANDLED_SRC.add(h.i);
        const x = rawSegs[h.i];
        if (!x) continue;
        mtN++;
        pushReview({
          kind: "meta-talk", priority: 2, s: x.s, e: x.e, segId: h.i,
          text: nzText(x.z).slice(0, 22), line: x.z,
          llm: { verdict: "keep", reason: h.kind === "head" ? "片头录制说明/试录，不是讲给观众的内容" : "片尾自言自语，不是内容收尾" },
          guard: { rule: "metaTalk", value: `命中「${h.hits.join("/")}」· ${h.durSec.toFixed(2)}s`, limit: "只标记，不自动删" },
          question: h.kind === "head" ? "这句像是在说明录制，不是内容。删掉还是保留？" : "这句像是在自言自语收尾，不是结论。删掉还是保留？",
          options: [{ label: "删除", cuts: [[x.s, x.e]] }, { label: "保留", cuts: [] }],
        });
        console.log(`  ? 元话语（${h.kind === "head" ? "片头" : "片尾"}）：#${h.i}「${nzText(x.z).slice(0, 18)}」命中「${h.hits.join("/")}」`);
      }
      METATALK_INFO = { meta: mtN, isolated: isoN, body: [iso.report.bodyStart, iso.report.bodyEnd] };
    }
    // 段级复核结果（asr_and_caps 的 XUNJIAN_SEGCHECK）：文本更完整，专门用来找被 20s 分块吞掉的语气词。
    try {
      const fp = path.join(EP, "work/raw-segs-fine.json");
      if (fs.existsSync(fp)) FINE_SEGS = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) { console.log(`  ⚠️ 段级复核结果不可读: ${e.message}`); }
    // ── 重说(③):召回优先出候选 → 若启用 LLM 裁决,交 LLM 判"是否真重说"(防误剪) ──
    const rtOpts = { ...R.retake };
    let rt;
    if (RETAKE_SIM_OPT != null) {
      rt = detectRetakes(rawSegs, { ...rtOpts, sim: Number(RETAKE_SIM_OPT) });   // 用户显式指定阈值 → 不做 LLM 裁决
    } else if (arbiterOk("retake-verdict")) {
      rt = detectRetakes(rawSegs, {
        ...rtOpts, sim: rtOpts.recallSim ?? rtOpts.sim,
        maxGapSec: rtOpts.recallGapSec ?? rtOpts.maxGapSec,
        lookAheadSegs: rtOpts.recallLookAhead ?? rtOpts.lookAheadSegs,
      });   // 放宽阈值/窗口提召回
      const cand = rt.report;
      if (cand.length) {
        step(`重说裁决（${LLM_MODEL}，${cand.length} 组候选）`);
        const v = adjudicate("retake", { pairs: cand.map((r, i) => ({ id: i, cut: r.cut, kept: r.kept, sim: r.sim, gap: r.gap })) });
        if (v && Array.isArray(v.verdicts)) {
          const cutIds = new Set(v.verdicts.filter((x) => x && x.verdict === "cut-first").map((x) => x.id));
          let picked = cand.filter((_, i) => cutIds.has(i));
          // ── 确定性命中：LCP 开头连续一致 ≥lcpMin 字（间隔 ≤lcpGapSec）/ 近乎逐字重复（sim ≥dupSim）──
          // 这两类都是高精度判据（实测三素材零误报），不需要 LLM 复核即可直接采纳，
          // 专门用来兜住"相似度判据漏检"与"剪/留文本几乎一样、LLM 反而判为刻意重复"两种失效。
          const detHits = cand.filter((r) => r.kind === "lcp" || r.kind === "dup");
          const pickedSet = new Set(picked);
          for (const r of detHits) if (!pickedSet.has(r)) { picked.push(r); pickedSet.add(r); }
          if (detHits.length) console.log(`  ✓ 确定性命中 ${detHits.length} 组（LCP/逐字重复），直接采纳`);
          // ── 换说法护栏（确定性）：保留文本是剪除文本的真后缀 → 前一遍更完整，剪掉会丢信息，一律不剪 ──
          // 实测 C0779：剪「我覺得孩子成績不好」/ 留「孩子成績不好」，用户明确要求保留完整那句。
          const _n0 = picked.length;
          picked = picked.filter(retakeSuffixOk);
          if (_n0 !== picked.length)
            console.log(`  ✓ 换说法护栏：拦下 ${_n0 - picked.length} 组「保留是剪除的后缀」的候选（保留更完整的前一遍）`);
          // ── 互斥重说对护栏 ──
          // A=「剪X留Y」与 B=「剪Y留X」是一对互斥判断（说话人前后说了两遍，检测器各指认了对方）。
          // 若两条都采纳，X 和 Y 会被**同时删掉**——整段内容凭空消失（实测 C0793：一次删掉 8.9s 连续语音），
          // 而正确做法永远是"保留后一遍"→ 只采纳**较早**的那条。这里做一次结构化的剔除。
          const nrm = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
          const dropIdx = new Set();
          for (let i = 0; i < picked.length; i++) {
            for (let j = i + 1; j < picked.length; j++) {
              if (nrm(picked[i].cut) === nrm(picked[j].kept) &&
                  nrm(picked[i].kept) === nrm(picked[j].cut)) dropIdx.add(j);
            }
          }
          if (dropIdx.size) {
            picked = picked.filter((_, i) => !dropIdx.has(i));
            console.log(`  ⚠️ 发现 ${dropIdx.size} 组互斥重说(剪A留B / 剪B留A)，已剔除靠后的那条，避免把 A、B 一起删掉`);
          }
          // 单条重说动辄超过 maxSpanSec 基本是误判（正常重说只重复一句话，1~5s）。
          // 不自动改，只在日志里喊一声，方便核对时按图索骥。
          const spanCap = R.retake.maxSpanSec ?? 6;
          const tooLong = picked.filter((r) => r.e - r.s > spanCap);
          if (tooLong.length) console.log(`  ⚠️ 有 ${tooLong.length} 组候选跨度 > ${spanCap}s（最长 ${(Math.max(...tooLong.map((r) => r.e - r.s))).toFixed(1)}s），疑似误判，请重点核对`);
          console.log(`  候选 ${cand.length} 组 → LLM 判定剪 ${picked.length} 组（其余保留，防误剪）`);
          const B = rtOpts.breatheSec ?? 0.05, MC = rtOpts.minCutSec ?? 0.3, MG = rtOpts.mergeGapSec ?? 0.1;
          const cs = picked.map((r) => [Math.max(0, r.s - B), r.e + B]).filter(([a, b]) => b - a >= MC).sort((a, b) => a[0] - b[0]);
          const merged = [];
          for (const c of cs) { const l = merged[merged.length - 1]; if (l && c[0] <= l[1] + MG) l[1] = Math.max(l[1], c[1]); else merged.push(c); }
          rt = { cuts: merged, report: picked };
        } else console.log("  ⚠️ 重说裁决不可用，回退算法结果");
      }
    } else {
      rt = detectRetakes(rawSegs, rtOpts);
    }
    // ── 拆段视图补召回（确定性）──
    // 基准视图的候选是整句比对：一个句段里「前一遍 + 重来版」黏在一起时，整句相似度被稀释，
    // 两边都判不出。拆段后两遍各自成单元，LCP / 逐字重复判据能直接命中（实测 C0777 #7）。
    // 只补**确定性命中**，不把低阈值候选塞进来 —— 拆段单元更短，低阈值在短文本上误报率高。
    if (SPLIT_ON && SEG.length > rawSegs.length) {
      const rts = detectRetakes(SEG, { ...rtOpts, lookAheadSegs: rtOpts.recallLookAhead ?? rtOpts.lookAheadSegs });
      const hits = rts.report.filter((r) => (r.kind === "lcp" || r.kind === "dup") && retakeSuffixOk(r));
      const taken = rt.report.map((r) => [r.s, r.e]);
      const add = hits.filter((h) => !taken.some(([a, b]) => h.s < b - 0.15 && h.e > a + 0.15));
      if (add.length) {
        const B2 = rtOpts.breatheSec ?? 0.05, MC2 = rtOpts.minCutSec ?? 0.3;
        const extra = add.map((r) => [Math.max(0, r.s - B2), r.e + B2]).filter(([a, b]) => b - a >= MC2);
        rt = { cuts: [...rt.cuts, ...extra].sort((x, y) => x[0] - y[0]), report: [...rt.report, ...add] };
        console.log(`  ✓ 拆段补召回：${add.length} 组（${add.map((r) => `「${r.cut.slice(0, 12)}」`).join(" ")}）`);
      }
    }
    // ── 假起头延伸（确定性）──
    // 同一句说了两遍、后一遍是「重来」的起点时，**前一遍的后半截也要一起删**。
    // 实测 C0779：#44「当你管住了自己的表情」→#45「改善了家庭的环境之后」→#46「孩子大脑也会慢慢地放松」
    // →#47 又重新说「当你管住了自己的表情」。重说检测只删 #44，留下 #45/#46 悬在中间，
    // 成片变成「…孩子大脑也会慢慢地放松／管住了自己的语言」，语义直接断掉。
    // 判据：前 6 字一致且重合度 ≥80%（近逐字重复）、跨度 ≤20s、中间不超过 3 句 → 删 [i, j) 整段，保留 j 起的重来版。
    {
      const _nz = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
      const nt = rawSegs.map((s) => _nz(s.z));
      const extra = [];
      const heads = new Set();
      // 已被前面的匹配当作废稿删掉的下标。它不能再当「前一遍」去匹配 ——
      // 否则会顺着它把重来版的**第一句**一起删掉。
      // 实测飞书 #56–#59（同一句话说了两遍、每句被云端 ASR 切成两段）：
      //   #56 那很多人只会死经被 / #57 哪怕是写了很多次这个月      ← 废稿
      //   #58 那很多人只会死经被 / #59 哪怕是写了很多次作文        ← 重来版
      // 匹配 #56→#58 正确删掉 #56、#57；接着 #57→#59 又匹配上（前缀「哪怕是写了很多次」8 字），
      // 于是把中间那一段里的 #58 一并删了 → 成片只剩「哪怕是写了很多次作文依然记不住」，
      // 主语「那很多人只会死劲背」整个消失。
      const killed = new Set();
      for (let j = 1; j < rawSegs.length; j++) {
        for (let i = Math.max(0, j - 6); i < j; i++) {
          const a = nt[i], b = nt[j];
          if (!a || !b) continue;
          let lcp = 0;
          while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++;
          if (lcp < 6 || lcp < Math.min(a.length, b.length) * 0.8) continue;
          if (rawSegs[j].s - rawSegs[i].s > 20 || j - i > 4) continue;
          heads.add(j);          // 重来版标记照记（它挡的是语义通道的误删）
          if (killed.has(i)) continue;   // 前一遍已经作废稿删掉了，不再从这里往外扩
          if (j - i >= 2) {
            // 中间的「纯设问短句」不吞（实测 C0777 #11→#13：中间夹着 #12「为什么？」0.39s，
            // 整段删掉后自问自答的设问没了，观众看到的是"结论突然跳出来"）。
            // 用户的验收意见也是「"为什么"属无关联漏剪」——设问是逻辑衔接，不能当重说的一部分删掉。
            const KEEP_Q = /^(为什么|为啥|咋回事|怎么回事|怎么说|什么意思)/;
            const parts = [];
            let cur = rawSegs[i].s, keptQ = 0;
            for (let k = i; k < j; k++) {
              const t = _nz(rawSegs[k].z);
              if (k > i && t.length > 0 && t.length <= 8 && KEEP_Q.test(t)) {
                if (rawSegs[k].s > cur) parts.push([cur, rawSegs[k].s]);
                cur = rawSegs[k].e;
                keptQ++;
              }
            }
            if (rawSegs[j - 1].e > cur) parts.push([cur, rawSegs[j - 1].e]);
            if (!parts.length) parts.push([rawSegs[i].s, rawSegs[j - 1].e]);
            for (const p of parts) extra.push(p);
            for (let k = i; k < j; k++) killed.add(k);
            console.log(`  ↻ 假起头：删 #${i}–#${j - 1}（${parts.reduce((a, [s2, e2]) => a + (e2 - s2), 0).toFixed(1)}s）` +
              `${keptQ ? `，保留中间 ${keptQ} 处设问（为什么/怎么回事）` : ""}，保留 #${j} 起的重来版「${_nz(rawSegs[j].z).slice(0, 12)}」`);
          }
          break;
        }
      }
      if (extra.length) rt = { cuts: [...rt.cuts, ...extra], report: rt.report };
      DUP_HEAD = heads;
    }
    // 句内"卡壳重说"：两套判据的证据基础不同，按 ASR provider 选。
    //   local(whisper)：长词 + 低 cps（whisper 把停顿吸收进词时长）
    //   cloud(paraformer)：段内假起头（真实字级时间戳下长词判据恒不成立，见 retake.mjs）
    const st = detectStutters(rawSegs, ASR_PROVIDER === "cloud"
      ? {
          mode: "inner-retake",
          minRepeatChars: R.stutter.minRepeatChars, maxHeadChars: R.stutter.maxHeadChars,
          minChars: R.stutter.innerMinChars, minCutSec: R.stutter.minCutSec,
          maxCutSec: R.stutter.innerMaxCutSec, tailMinChars: R.stutter.tailMinChars,
          leadRestart: R.stutter.leadRestart, leadMaxChars: R.stutter.leadMaxChars,
          leadPauseSec: R.stutter.leadPauseSec, leadMaxCutSec: R.stutter.leadMaxCutSec,
        }
      : {
          word: R.stutter.longWordSec, cps: R.stutter.cpsThreshold,
          minSeg: R.stutter.minSegSec, minChars: R.stutter.minChars, minCutSec: R.stutter.minCutSec,
        });
    // ── 语气词(④):tier1 纯白名单直接剪;tier2(这个/那个…)交 LLM 判上下文 ──
    const flOn = !(R.filler && R.filler.enabled === false);
    // 删除后留白：前字尾→切口起点 + 切口终点→后字头。两项都接近 0，说明该词被前后字**夹死**在
    // 连续语流里，删掉它就是把两个字的音直接焊在一起 —— 听感上是一个断点（比留着那个垫词更难受）。
    // 实测 C0779「大脑记忆‖这个‖开关」三处「这个」两侧留白全是 0.000s；而 C0777 那处
    // 「…是这个‖1.31s 静音‖当孩子…」留白 1.31s，删得干净。故判据：留白 <0.10s → 不剪。
    const _nzW = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    const gapAround = (s, e) => {
      let prevEnd = null, nextStart = null;
      for (const sg of RAW_SEGS) {
        for (const [ws, we, word] of sg.w || []) {
          if (!_nzW(word)) continue;
          if (we <= s + 0.02 && (prevEnd == null || we > prevEnd)) prevEnd = we;
          if (ws >= e - 0.02 && (nextStart == null || ws < nextStart)) nextStart = ws;
        }
      }
      return (prevEnd == null ? 99 : s - prevEnd) + (nextStart == null ? 99 : nextStart - e);
    };
    const GAPMIN = R.filler.minGapAfterCutSec ?? 0.10;
    let fl = flOn ? detectFillers(rawSegs, {
      tier1: (R.filler && R.filler.tier1) || undefined,
      standalonePauseSec: R.filler && R.filler.standalonePauseSec,
      maxDurSec: R.filler && R.filler.maxDurSec,
      minCutSec: R.filler && R.filler.minCutSec,
    }) : { cuts: [], report: [] };
    // tier1 同样过留白护栏：真语气词通常独立成说（「…停顿…嗯…」），两侧留白足够；
    // 被前后字夹住的那种删了同样是硬拼。
    if (fl.cuts.length) {
      const keep = [];
      fl.cuts.forEach((c, i) => {
        const g = gapAround(c[0], c[1]);
        if (g < GAPMIN) console.log(`  ✓ 留白护栏：保留「${fl.report[i].cut}」（两侧仅 ${g.toFixed(2)}s，删了是硬拼）`);
        else keep.push(i);
      });
      if (keep.length !== fl.cuts.length) {
        fl = { cuts: keep.map((i) => fl.cuts[i]), report: keep.map((i) => fl.report[i]) };
      }
    }
    if (fl.report.length) console.log(`  检测到语气词(tier1) ${fl.report.length} 处`);
    let f2 = { cuts: [], report: [] };
    if (flOn && R.filler.tier2Llm !== false && arbiterOk("filler-verdict")) {
      // 语气词候选优先用段级复核转写：20s 分块会吞掉「这个/那个」这类短词，
      // 主转写里没有 → 候选都没生成，护栏再严也剪不到（实测 C0779「孩子看到脸上是[这个]比较松弛的」）。
      const cands = findTier2(FINE_SEGS.length ? FINE_SEGS : rawSegs, R.filler.tier2 || [], { standalonePauseSec: R.filler.standalonePauseSec });
      // 细通道只提供「某处有个语气词」的位置；它的短上下文错字多，不能直接给 LLM 当语义依据。
      // 用主通道同一时间的整句回填 lineMain，让 LLM 用主文本判断是垫词还是回指。
      for (const c of cands) {
        const host = RAW_SEGS.find((x) => x.s <= c.s + 0.05 && x.e >= c.e - 0.05)
          || RAW_SEGS.filter((x) => x.s < c.e && x.e > c.s).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
        if (host && host.z) c.lineMain = host.z;
      }
      if (cands.length) {
        step(`语气词裁决（${LLM_MODEL}，${cands.length} 个候选）`);
        const v = adjudicate("filler", { items: cands.map((c, i) => ({ id: i, text: c.text, before: c.before, after: c.after, line: c.line, lineMain: c.lineMain || "", prev: c.prev, pos: c.pos, standalone: c.standalone })) });
        if (v && Array.isArray(v.verdicts)) {
          const cutIds = new Set(v.verdicts.filter((x) => x && x.verdict === "cut").map((x) => x.id));
          // 三层确定性护栏（LLM 只表态，剪不剪由这里裁决）：
          // ① 兼实义词落在句段首/尾 → 一律不剪。实测 C0777「就是做样子给孩子来看」的「就是」被判填充词，
          //    成片变成「做样子给孩子来看」，判断句被说成陈述句，语义断了。句段边界不是停顿，不能当"独立成说"的证据。
          // ② 「这个/那个」不再要求独立成说。实测 C0779「而在于家里这个气氛怎么样」前后紧贴，
          //    但确实是垫词；交由 LLM 结合 prev（上一句原文）判断「泛指垫词 / 回指前文具体事物」。
          // ③ 其余 tier2（然后/那么/其实/对吧/是吧）仍要求前后都有停顿。
          const HEAD_TAIL_KEEP = new Set(["就是", "就是說", "然后", "然後", "那么", "那麼", "其实", "其實",
            "所以", "但是", "因为", "因為", "而且", "如果", "对吧", "對吧", "是吧"]);
          const DEMON = new Set(["这个", "這個", "那个", "那個"]);
          const picked = [], blockedHead = [], blockedStick = [], blockedGap = [];
          cands.forEach((c, i) => {
            if (!cutIds.has(i)) return;
            // ④ 留白护栏（对 tier2 全体生效，包括「这个/那个」的短路分支）：
            // 这个词被前后字夹死在连续语流里，删掉就是把两个音直接焊上 —— 是断点，不是利落。
            const g = gapAround(c.s, c.e);
            if (g < GAPMIN) { blockedGap.push({ c, g }); return; }
            if (HEAD_TAIL_KEEP.has(c.text) && (c.pos === "head" || c.pos === "tail")) { blockedHead.push({ c, rule: "headTailKeep" }); return; }
            if (DEMON.has(c.text)) {
              // 「这个/那个 + 泛称名词」是指示结构的一部分（这个事儿/这个情况/这个人），
              // 删掉会缺量词、变成病句（实测「当爸爸这个事儿说到底」→「当爸爸事儿说到底」）。
              if (/^(事儿|事|东西|时候|地方|人|话|问题|情况|样子|感觉|状态)/.test(c.after || "")) {
                blockedHead.push({ c, rule: "demonNoun" }); return;
              }
              picked.push(c); return;
            }
            if (!c.standalone) { blockedStick.push(c); return; }
            picked.push(c);
          });
          if (blockedHead.length)
            console.log(`  ✓ 句首实义护栏：保留 ${blockedHead.length} 个（${blockedHead.map((x) => `「${x.c.text}」`).join("")}在句首/句尾，属句法成分而非垫词）`);
          if (blockedGap.length)
            console.log(`  ✓ 留白护栏：保留 ${blockedGap.length} 个（${blockedGap.map((x) => `「${x.c.text}」两侧 ${x.g.toFixed(2)}s`).join("、")}，删了是硬拼）`);
          if (blockedStick.length)
            console.log(`  ✓ 独立成说护栏：拦下 ${blockedStick.length} 个「与前后文紧贴、非独立成说」的语气词`);
          // ── 不落审核队列 ──
          // 语气词是「词级切除」：模型判删、但句法/留白/指示结构任一条护栏没把握时，
          // 一律按「保留」处理，不再丢进「待确认」逐条问。
          // 理由：单个垫词两三个字，用户没有判断依据；实测一条素材能攒十几条，
          // 把真正要拍板的整句挤出第一屏。护栏拦了多少仍打进日志，复盘看 run.log。
          console.log(`  候选 ${cands.length} 个 → LLM 判定删 ${picked.length} 个`);
          f2 = { cuts: picked.map((c) => [c.s, c.e]), report: picked.map((c) => ({ s: c.s, e: c.e, cut: c.text, kept: "（tier2 语气词，删除）", reason: `LLM 判为填充词${c.standalone ? "" : " · 与前后文紧贴"}` })) };
        } else console.log("  ⚠️ 语气词裁决不可用，跳过 tier2");
      }
    }
    // ── 语义冗余扫描(步3)：对**含片头尾的完整句段列表**一次性打标签 ──
    // 确定性检测（相似度/LCP/词时长）抓不到的三类，只能靠语义判断：
    //   ① 离题题外话（片头寒暄、片尾告别）  ② 口误（说错即改、但没把正确的话重说一遍）
    //   ③ 换说法重说（同义不同词，文本相似度天然失效）
    // 设计原则：LLM 只表态，剪不剪由下面四条**确定性护栏**裁决 ——
    //   ① 总删除时长 ≤ 全片 maxRatio（默认 22%），超了整批不剪（防"整片被删光"）
    //   ② 连续删除句段 ≤ maxRun（默认 3），防一段话被整块吞掉
    //   ③ paraphrase 必须给出**有效且向后的** keepId（永远保留后一遍），否则忽略
    //   ④ 单句跨度 > maxSegSec（默认 20s）基本是误判，忽略
    // ── 分句级「及物动词悬空」扫描（确定性，独立于 LLM）──
    // 判定粒度必须到分句：ASR 的句段是"一口气说完的一整段"（实测 #6 有 71 字 / 14s），
    // 口误只占末尾 22 字时，整句相似度被前面的正确内容稀释到 0.17（阈值 0.6），
    // 两边都判不出来 —— 既不像重说、也不像口误，模型看整段觉得"总体成立"就标 ok。
    // 实测 ui-李威…040947：#6 末分句「…记住几百个」与 #7 第 2 分句「…一遍记住啊」
    // 都是动词后面只剩数量/语气词，下一句紧接着补全，被整句级判定完全漏掉。
    const DANGLING = detectDangling(rawSegs, {
      minChars: R.redundancy?.danglingMinChars ?? 4,
      minClauseSec: R.redundancy?.danglingMinSec ?? 0.5,
    });
    if (DANGLING.length) console.log(`  · 分句悬空扫描：${DANGLING.length} 处（${DANGLING.filter((d) => !d.wholeSeg).length} 处可只删分句）`);
    // ── 结构路由（步 3 之前）：确定性结构问题不交给语义通道裁决 ──
    // 两条通道对同一段各给一个结论时，切口是**叠加**而不是覆盖：语义通道判得更宽
    // （整段 offtopic）就吞掉起头通道判得更细的那一刀 —— 白判、白花钱、还要删错。
    // 实测 C0816 #0：redundancy 判 offtopic 整段删 [0.03,10.49]，inner-restart 对同一段
    // 判 drop:[0,1] 只删 [2.61,5.77]，合并后前者赢，开场第一个论点被删掉。
    // 做法：送审时句段**仍留在 payload 里**（上下文不能丢），只多一个 handled 标记；
    // 回收时这些 id 的判决一律不入账，模型原始判断写 llm-shadow.json 供事后比对。
    // 路由的唯一作用是「给语义通道送审打标记 + 过滤它的判决」，语义通道不跑时它没有意义，
    // 所以启用条件与下面的 redundancy 分支完全一致 —— 否则会出现「两边都不管」的句段。
    const REDUNDANCY_ON = arbiterOk("redundancy-scan") && R.redundancy?.enabled !== false &&
      process.env.XUNJIAN_REDUNDANCY !== "off" && SEG.length >= 4;
    const STRUCT_ROUTE = new Map();
    if (REDUNDANCY_ON && ASR_PROVIDER === "cloud" && process.env.XUNJIAN_INNER_RESTART !== "off" && arbiterOk("inner-restart")) {
      const _mc = R.stutter?.midRestart || {};
      for (const c of detectMidRestarts(rawSegs, {
        pauseSec: _mc.pauseSec, minAttempts: 2,
        minRepeatChars: _mc.minRepeatChars, minChars: _mc.minChars,
      })) {
        // 只路由 ≥3 遍的段。2 遍的段交过去等于放弃删除：起头通道有「首段不删」保护，
        // 两遍里唯一可删的第 0 遍会被它挡掉，结果是"语义通道判 slip、起头通道删 0 秒"。
        // 全库实测：2 遍段 6 段，路由后合计少删 28.8s 且不产生任何改善。
        if (c.attempts.length < 3) continue;
        STRUCT_ROUTE.set(c.segId, { kind: "restart", detail: `${c.attempts.length} 遍起头 · ${c.phrase}` });
      }
      if (STRUCT_ROUTE.size)
        console.log(`  · 结构路由：${STRUCT_ROUTE.size} 段交起头通道裁决（#${[...STRUCT_ROUTE.keys()].join(",#")}），语义判决不入账`);
    }
    // 影子判决：结构路由丢掉的语义判断，留一份给「结构通道最终没删」时提示
    const STRUCT_SHADOW = new Map();
    let rs = { cuts: [], report: [] };
    if (REDUNDANCY_ON) {
      const RS = R.redundancy || {};
      const nrmT = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
      // ── 两条语义护栏的公共判据（确定性，不花模型）──
      // ① 疑问句识别：口播/对话体里，提问是**内容骨架**（家长问—老师答、主持人问—嘉宾答），
      //    删掉提问，回答就变成没头没尾的独白。模型不懂体裁，会把"提问"一律读成"互动寒暄"。
      //    实测 C0853：全片就是问答体，模型把 #10–#13 四句提问全判 offtopic；用户判「老师你这个
      //    到底是什么方法呢」应保留。这里按句式特征识别，不依赖标点（送模型的文本已被 nrmT 去标点）。
      //    「吧」不能单独当问句证据（2026-11-04）：口播里"开始吧 / 就这样吧 / 没关系吧"是祈使或收尾，
      //    正是 offtopic 定义里"片头寒暄 / 片尾收尾"那两类；一律当提问会**保护住本该删的东西**。
      //    反问标签（对吧/是吧/好不好）仍算提问 —— 那是内容的一部分，不是寒暄。
      //    （判据已收敛到 question-cut.mjs 的 looksLikeAsk，两处各写一份曾出现改了一边忘另一边）
      const looksLikeQuestion = looksLikeAsk;
      // ② 最长公共子串：slip 的语义是"同一个意思说了两遍"，被删句与保留句之间必须能看到
      //    **同一段措辞**。看不到就只是"这句读不通"，那是 ASR 的事，不是说话人的口误。
      const lcsLen = (a, b) => {
        let best = 0;
        for (let x = 0; x < a.length; x++) {
          for (let y = 0; y < b.length; y++) {
            let k = 0;
            while (x + k < a.length && y + k < b.length && a[x + k] === b[y + k]) k++;
            if (k > best) best = k;
          }
        }
        return best;
      };
      // ③ slip 的重说证据（确定性，2026-11-05）：不看模型的措辞，只看文本里有没有"重说"的结构证据。
      //    旧实现是拿理由里的 8 个关键词（转写/病句/读不通…）去猜模型有没有说"这是转写错误"，
      //    判据挂在模型的用词上：同一条 C0853 #3，一次写"明显转写错误"被拦成卡片，另一次写
      //    "明显口误"就整段删掉 —— 两次最长公共串都是 2、句子一字不差，差的只是一个词。
      //    三条任一成立即放行，都不成立才进待确认。
      const SEV = { minRun: 6, minSelfRepeat: 4, minPrefix: 4, ...(RS.slipEvidence || {}) };
      const selfRepeatLen = (s) => {
        for (let L = Math.min(12, s.length >> 1); L >= SEV.minSelfRepeat; L--) {
          for (let i = 0; i + L <= s.length; i++) {
            if (s.indexOf(s.slice(i, i + L), i + L) >= 0) return L;
          }
        }
        return 0;
      };
      const prefixLen = (a, b) => {
        let k = 0;
        while (k < a.length && k < b.length && a[k] === b[k]) k++;
        return k;
      };
      const slipEvidence = (a, b) => {
        const run = b ? lcsLen(a, b) : 0;
        const rep = selfRepeatLen(a);
        const pre = b ? prefixLen(a, b) : 0;
        return { run, rep, pre, ok: run >= SEV.minRun || rep >= SEV.minSelfRepeat || pre >= SEV.minPrefix };
      };
      // ④ 片头口令/调试前缀：设备口令（"等一下/三二一/开始念/开始"）常和正文第一句被 ASR 合成一段，
      //    整段删会把开场痛点一起删掉。只认明确的开机口令，正文里的"开始"不算。
      const CMD_ANY = /(等一下|等下|三二一|321|一二三|开始念|开始录|准备录|录了吗|停一下|重来|再来一遍|开始)/g;
      const CMD_STRONG = /(等一下|等下|三二一|321|一二三|开始念|开始录|准备录|录了吗|停一下|重来|再来一遍)/;
      const cmdPrefixCut = (sg) => {
        const full = nzText(sg.z);
        const ts = [];
        for (const w of sg.w || []) for (const _ of nzText(w[2])) ts.push(w[0]);
        if (!full || ts.length < full.length) return null;   // 词级时间戳缺失 → 放弃
        let lastEnd = -1;
        CMD_ANY.lastIndex = 0;
        for (let m; (m = CMD_ANY.exec(full)); ) lastEnd = m.index + m[0].length;
        if (lastEnd < 0 || lastEnd > 26) return null;        // 没有口令，或"口令"出现得太靠后
        if (!CMD_STRONG.test(full.slice(0, lastEnd))) return null;   // 正文里的"开始"不算口令
        if (full.length - lastEnd < 8) return null;          // 口令之后没剩正文 → 整段删就好
        let k = lastEnd;
        // 跳过紧随其后的短起头：「我家背单」→「我家孩子背单词」这种同头半截
        const head2 = full.slice(k, k + 2);
        if (head2.length === 2) {
          const again = full.indexOf(head2, k + 2);
          if (again > k && again - k <= 6 && full.length - again >= 6) k = again;
        }
        const a = sg.s, b = ts[k];
        if (b == null || !(b - a >= 0.3 && b - a <= 10)) return null;
        return { a, b, del: full.slice(0, k) };
      };
      // ④ 问句的"短前导卡壳"：只删前导，保留完整的那一遍问法。
      // 实测 C0853 #13「呃，老师那到底呃呃老师你这个到底是什么方法呢？」（59.6–64.4）：
      // 前 2.7s 是"呃老师那到底呃呃"的卡壳，真正要问的是后半句；用户判「老师你这个到底是什么方法呢」应保留。
      // 判据：问句 + 跳过句首语气词后的 2 字短语在 12 字内再现 + 再现处之后还剩 ≥6 字 + 切口 0.3~6s。
      const FILLER_HEAD = /^[呃嗯啊哦额唉哎]+/;
      const FILLER_CHAR = /[呃嗯啊哦额唉哎]/;
      const repeatPrefixCut = (sg) => {
        const full = nzText(sg.z);
        const ts = [];
        for (const w of sg.w || []) for (const _ of nzText(w[2])) ts.push(w[0]);
        if (!full || ts.length < full.length) return null;
        const lead = (full.match(FILLER_HEAD) || [""])[0].length;
        const k0 = lead <= full.length - 8 ? lead : 0;
        const head2 = full.slice(k0, k0 + 2);
        if (head2.length < 2) return null;
        const again = full.indexOf(head2, k0 + 2);
        if (again < 0 || again - k0 > 12) return null;
        let k2 = again;
        while (k2 < again + 3 && FILLER_CHAR.test(full[k2])) k2++;   // 重来版前面残留的"呃"
        if (full.length - k2 < 6) k2 = again;
        if (full.length - k2 < 6) return null;
        const a = sg.s, b = ts[k2];
        if (b == null || !(b - a >= 0.3 && b - a <= 6)) return null;
        return { a, b, del: full.slice(0, k2) };
      };
      // ⑤ 片头"多次起头"：一句正文被自己打断两三遍，ASR 合成一段。模型读到的是一串复读，
      //    很容易判 offtopic（"试音/调试堆叠"）整段删除，而正文恰恰在最后一遍里。
      //    实测 C0816 #0：三遍「再比如说数学」后接「数学首先你要记住一些基本的数学的概念」，
      //    整段删会把开场第一个论点一起删掉。判据是确定性的（≥5 字短语跨 ≥3 次起头复现），
      //    命中即只删到"最后一遍重说起头"之前，保留结尾正文。
      const midRestartHeadCut = (sg) => {
        const MID = R.stutter?.midRestart || {};
        const cands = detectMidRestarts([sg], {
          pauseSec: MID.pauseSec, minAttempts: MID.minAttempts,
          minRepeatChars: MID.minRepeatChars, minChars: MID.minChars,
        });
        const c = cands[0];
        if (!c) return null;
        const at = c.attempts || [];
        // 取「最后一次仍含重复短语的起头」：它之后是正文/补全，一并保留
        let k = -1;
        for (let j = 1; j < at.length; j++) if (at[j].text.includes(c.phrase)) k = j;
        if (k < 1) return null;
        const a = c.s, b = at[k].s;
        const dur = b - a;
        if (!(dur >= (MID.minCutSec ?? 0.3) && dur <= (MID.maxCutSec ?? 12))) return null;
        const remain = at.slice(k).reduce((n, x) => n + x.text.length, 0);
        if (remain < (MID.minRemainChars ?? 12)) return null;
        return { a, b, del: at.slice(0, k).map((x) => x.text).join(" / "), kept: at.slice(k).map((x) => x.text).join("") };
      };
      // ⑥ 片头多次起头的**兜底**：结构证据在，但 ⑤ 的几何守卫不满足（切口 >12s、尾部不足 12 字）时，
      //    不允许静默整段删 —— 那是同一种误判，只是这一段的形状刚好躲过了自动切口。
      //    这类几何全库目前 0 例（唯一命中就是 C0816，已被 ⑤ 自动修好），所以它是给未来留的门：
      //    命中即弹三档卡，整段删 / 只删作废的起头 / 保留，由人拍板。
      const midRestartEvidence = (sg) => {
        const MID = R.stutter?.midRestart || {};
        const c = detectMidRestarts([sg], {
          pauseSec: MID.pauseSec, minAttempts: 2,
          minRepeatChars: MID.minRepeatChars, minChars: MID.minChars,
        })[0];
        if (!c) return null;
        const at = c.attempts || [];
        let k = -1;
        for (let j = 1; j < at.length; j++) if (at[j].text.includes(c.phrase)) k = j;
        if (k < 1) return null;
        return { n: at.length, keepAt: at[k].s, a: c.s, phrase: c.phrase };
      };
      step(`语义冗余扫描（${LLM_MODEL}，${SEG.length} 句）`);
      const v = adjudicate("redundancy", {
        segments: SEG.map((x, i) => ({
          id: i, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nzText(x.z),
          // 结构路由：仍在列表里（前后文要完整），只是不要求模型表态
          ...(STRUCT_ROUTE.has(x.srcId) ? { handled: "restart" } : {}),
        })),
      });
      if (v && Array.isArray(v.verdicts)) {
        // ── 结构路由分流：交给起头通道的句段，语义判决一律不入账 ──
        // 不改模型输出、不删字段，只在这里把它们摘出来；原始判断写影子文件，
        // 结构通道最终没删成时（模型判"全保留"或被护栏拦）它才是唯一的线索。
        const routedOf = (x) => {
          const u = SEG[Number(x && x.id)];
          return !!u && STRUCT_ROUTE.has(u.srcId);
        };
        const routedOut = v.verdicts.filter(routedOf);
        for (const x of routedOut) if (x && x.label) STRUCT_SHADOW.set(Number(x && x.id), x);
        const liveVerdicts = routedOut.length
          ? v.verdicts.filter((x) => !routedOf(x))
          : v.verdicts;
        // 注意：不能用"模型判 ok"来撤销路由。送审时我们要求它对这些段原样标 ok，
        // 它照做之后，这个 ok 就不再是判断，而是服从指令的产物 —— 拿它当"这段没问题"
        // 的证据会形成闭环：模型不判了 → 路由撤销 → 起头通道也跳过 → 两个通道都不管。
        // 实测 C0816 第一版就掉进这个坑，成片首段留着「那端的补助是嗯数学吧」。
        if (routedOut.length) {
          console.log(`  ↷ 结构路由：${routedOut.length} 段语义判决不入账 · ${routedOut.map((x) => `#${x.id}:${x.label}`).join(" ")}`);
          try {
            fs.writeFileSync(path.join(EP, "work/llm-shadow.json"), JSON.stringify({
              note: "结构路由：这些句段的语义判决仅作影子记录，不参与剪辑；结构通道（inner-restart）才是它们的裁决方。",
              route: [...STRUCT_ROUTE].map(([id, r]) => ({ id, ...r })),
              verdicts: routedOut,
            }, null, 1));
          } catch (e) { console.log(`  ⚠️ 影子判决写入失败: ${e.message}`); }
        }
        // 裁决落盘：复核时"某句为什么没剪"全靠这张表，重放一次要花一次 API 调用。
        // 与 retake-report / filler-report 并列，只写原始标签，不做二次加工。
        try {
          fs.writeFileSync(path.join(EP, "work/redundancy-verdicts.json"), JSON.stringify({
            model: LLM_MODEL,
            routed: [...STRUCT_ROUTE.keys()],
            segments: SEG.map((x, i) => ({ id: i, srcId: x.srcId, part: x.part, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nzText(x.z) })),
            verdicts: v.verdicts,
          }, null, 1));
        } catch (e) { console.log(`  ⚠️ 裁决明细写入失败: ${e.message}`); }
        const LABELS = new Set(["offtopic", "slip", "paraphrase", "filler"]);
        // ── 句段内子切口 ──
        // whisper 常把「说错/卡住」和「改正后重说」合并成一个长句段（实测 C0777
        // 「相反的一个脾气相反的一个脾气一点就着」22 字）。整句删会连正确内容一起丢，
        // 整句跳过又漏剪 —— 用户明确要求"只保留最终那一遍"。
        // 做法：找「句首短语在句中再次出现」的位置作锚点，只删第一次出现的前半段。
        const slipPrefixCut = (sg) => {
          const full = nzText(sg.z);
          const ts = [];
          for (const w of sg.w || []) for (const _ of nzText(w[2])) ts.push(w[0]);
          if (ts.length < full.length) return null;          // 词级时间戳缺失，放弃
          const maxL = Math.min(14, Math.floor(full.length / 2));
          for (let L = maxL; L >= 4; L--) {
            const head = full.slice(0, L);
            const k = full.indexOf(head, Math.max(3, L - 2));
            if (k > 0 && k <= full.length - 4) {
              const a = sg.s, b = ts[k];
              if (b - a < 0.3 || sg.e - b < 0.8) continue;  // 切出来太碎，不值当
              return { a, b, head, del: full.slice(0, k) };
            }
          }
          return null;
        };
        // 前件依赖词：以这些词开头的句子，语义上依附前一句（"第一个要改的是…"）。
        // 此时前一句是它的前件，不是"被它替代的旧说法"。
        const DEP_START = /^(第[一二三四五六七八九十]+个?|首先|其次|那么|所以|因为|如果|要是|否则|而|但是|但|不过|于是|於是)/;
        // 长 slip 的「重复片段」兜底：本句是卡壳/重说的前一遍，而**下一句原样说出了它中间的一段**
        // → 下一句才是最终版，本句整句可删。
        // 实测 c3 #8「我然后再说一点就是再说一点就是我觉得习惯也特别的重要啊，那你哪怕是一个人跑的」
        // （37 字 / 7.9s）与 #9「第三点，我觉得最后一点，我觉得习惯也特别的重要」（20 字）共有
        // 「我觉得习惯也特别的重要」11 字，但重复片段在**中段**而非句首，slipPrefixCut 找不到锚点 → 整段漏剪。
        // 三条反向护栏：① 公共片段 ≥10 字且其中汉字 ≥8（"是在2011年的"这类数字+虚词不算）；
        // ② 后一遍更短（前一遍是带重复的卡壳版）；③ 只认相邻下一句。宁漏勿错。
        const coveredByNext = (i) => {
          const a = nzText(SEG[i].z), nx = SEG[i + 1];
          if (!a || !nx) return null;
          const b = nzText(nx.z);
          if (!b || b.length >= a.length) return null;
          for (let L = Math.min(14, b.length); L >= 10; L--) {
            for (let k = 0; k + L <= a.length; k++) {
              const frag = a.slice(k, k + L);
              if ((frag.match(/[\u4e00-\u9fff]/g) || []).length < 8) continue;
              if (b.includes(frag)) return { frag, nextId: i + 1 };
            }
          }
          return null;
        };
        // 长 slip 的「段内重复短语」兜底（第三种形状）。
        // 实测 c1 #5（52 字 / 9.73s）：
        //   「我当年是在2011年的，我第二个是他在自己讲的专业要第二个是他对转讲，
        //     第二个是他对于自己讲内容要有一定的专长。」
        // 同一短语「第二个是他」在段内出现 3 次 —— 这是连卡三遍，最终版在后面的独立句段（#12）。
        // 但：重复在**中段**（slipPrefixCut 无锚点）、下一句不含公共片段（coveredByNext 不成立）
        // → 两条兜底都落空，LLM 已判 slip 却一字未剪。
        // 反向护栏：① 必须 5 字短语（4 字重复在正常口播里很常见：c3「一个好的状态/方法/习惯」）；
        // ② 只认 keepId 明确指向后面的句段（方向由 LLM 给定，不靠猜）。
        const repeatedPhrase = (i) => {
          const t = nzText(SEG[i].z);
          if (t.length < 15) return null;
          const cnt = new Map();
          for (let k = 0; k + 5 <= t.length; k++) {
            const g = t.slice(k, k + 5);
            if ((g.match(/[\u4e00-\u9fff]/g) || []).length < 5) continue;
            const c = (cnt.get(g) || 0) + 1;
            cnt.set(g, c);
            if (c >= 3) return g;
          }
          return null;
        };
        // 长 slip 的「段内重来」兜底（第四种形状）：段首一小截作废后，同一 **≥7 字短语**从段内重来。
        // 实测 C0777 #2（40 字 / 8.8s）：
        //   「老是｜一个家庭里面最该成长的那天我觉得｜一个家庭里面最该成长的首先是爸爸，其次才是孩子。」
        // 第一遍从第 2 字起、第二遍从第 18 字起，公共短语 12 字 —— 但**两遍都不对齐段首**
        // （段首多了"老是"），所以 slipPrefixCut（要求从段首起始）与 detectInnerRetakes
        // （要求重来版从段首字开始）同时漏掉；重复只有 2 次，第三条 repeatedPhrase（≥3 次）也不命中。
        // #7 同理：「那看到孩｜当孩子看到爸爸的脸是这个｜当孩子看到爸爸脸是松的…」。
        // 四条护栏：① 公共短语 ≥7 字；② 第一遍起点在段首 ≤4 字内（确认是"起头"不是句中并列）；
        //          ③ 第二遍起点在段首 ≤22 字内（重来发生在开头，不是远距离呼应）；
        //          ④ 第二遍之后还剩 ≥12 字（保留的是完整句子）。
        const repeatedHead = (i) => {
          const t = nzText(SEG[i].z);
          if (t.length < 30) return null;
          for (let L = 12; L >= 7; L--) {
            const last = new Map();
            for (let k = 0; k + L <= t.length; k++) {
              const g = t.slice(k, k + L);
              if ((g.match(/[\u4e00-\u9fff]/g) || []).length < L - 1) continue;
              const prev = last.get(g);
              if (prev == null) { last.set(g, k); continue; }
              if (prev <= 4 && k <= 22 && k - prev >= 2 && t.length - k >= 12) {
                return { frag: g, cutChars: k, firstAt: prev, text: t };
              }
              last.set(g, k);
            }
          }
          return null;
        };
        // 末尾分句能否单独成一档：句首得留下 ≥1s 正文，末尾分句本身 ≥0.6s。
        // 否则「只删末尾」和「整段删」是同一段区间，两档并列只会让人更犹豫。
        const _tailRoom = (cls, sg) => cls.length >= 2 &&
          cls[cls.length - 1].s - sg.s >= 1.0 && sg.e - cls[cls.length - 1].s >= 0.6;
        const picked = [];
        for (const it of liveVerdicts) {
          const i = Number(it && it.id);
          if (!Number.isInteger(i) || i < 0 || i >= SEG.length) continue;
          // 这句已被 2.6~2.8 处理过（低电平整句 / 同义问句 / 元话语 / 孤立句）：
          // 不再重复判、更不能重复出卡，否则「已经删干净了还弹一张问要不要删」。
          if (PRE_HANDLED_SRC.has(SEG[i].srcId)) continue;
          const label = String((it && it.label) || "");
          if (!LABELS.has(label)) continue;
          // ── filler 不得整句删 ──
          // redundancy 的 filler 只表示"这句里夹了个语气词"，不是"整句该丢"。
          // 语气词已有专门通道做**词级切除**（tier1 直剪 / tier2 交 LLM 判上下文）。
          // 实测 c3：标了 filler 的「啊，那第二个我觉得是就一个人的状态」被整句删 3.9s，
          // 连带把「第二个」这个论点引导句一起删掉，成片只剩第一和第三个论点。
          if (label === "filler") {
            console.log(`  ↷ 忽略 filler（${nzText(SEG[i].z).slice(0, 14)}）：语气词走词级切除，不整句删`);
            continue;
          }
          // ── offtopic 位置护栏（确定性）──
          // 实测 qwen-plus 会把「我当年毕业武汉大学拿遍了奖学金」「我 2011 年代表中国拿了
          // 世界冠军」这类**论据自述**判成 offtopic（理由"冗余权威背书、未转化为论证"），
          // 而它们恰恰在支撑前一句提出的「第一个是学习能力」「第二个是有专长」。
          // 粗剪不该做"论证是否有力"的编辑判断 —— 那会把视频剪成只剩论点、没有证据。
          // 故：offtopic 只允许出现在片头/片尾，中段一律保留（宁可漏剪）。
          if (label === "offtopic") {
            const hN = RS.offtopicHeadSegs ?? 2, tN = RS.offtopicTailSegs ?? 2;
            // 片头：口令与正文同段 → 只删口令前缀，保留后面的正文（详见 cmdPrefixCut）
            if (SEG[i].srcId < hN) {
              const pc = cmdPrefixCut(SEG[i]);
              if (pc) {
                console.log(`  ✂ 片头口令分离：删「${pc.del}」${(pc.b - pc.a).toFixed(2)}s，保留「${nzText(SEG[i].z).slice(pc.del.length, pc.del.length + 14)}…」`);
                picked.push({
                  i, label, keepId: null,
                  reason: `${it.reason || "判为片头寒暄"} · 只删口令/调试前缀，正文保留`,
                  cutRange: [pc.a, pc.b], cutText: pc.del,
                });
                continue;
              }
              // 没有口令，但可能是"同一句正文起了三四遍"：模型把它读成试音堆叠，整段判 offtopic。
              // 只删掉前面作废的几遍，最后一遍正文保留（实测 C0816 开场论点就藏在第三遍里）。
              const mc = midRestartHeadCut(SEG[i]);
              if (mc) {
                console.log(`  ✂ 片头多次起头分离：删前 ${(mc.b - mc.a).toFixed(2)}s「${mc.del.slice(0, 18)}…」，保留「${mc.kept.slice(0, 16)}…」`);
                picked.push({
                  i, label, keepId: null,
                  reason: `${it.reason || "判为片头寒暄"} · 只删作废的起头，最后一遍正文保留`,
                  cutRange: [mc.a, mc.b], cutText: mc.del,
                });
                continue;
              }
              // ⑤ 的自动切口没接住（切口太长 / 尾部太短）：至少不许静默整段删，把三档摆出来让人拍板。
              const ev = midRestartEvidence(SEG[i]);
              if (ev) {
                const x = SEG[i];
                const headCut = ev.keepAt > x.s + 0.3 && ev.keepAt < x.e - 0.3;
                console.log(`  ? 片头多次起头：待确认 #${i}（${ev.n} 遍「${ev.phrase}」，整段删会丢掉最后一遍正文）`);
                pushReview({
                  kind: "head-restarts", priority: 1, s: x.s, e: x.e, segId: i,
                  text: nzText(x.z).slice(0, 22), line: x.z,
                  llm: { verdict: "cut", reason: it.reason || "判为片头寒暄" },
                  guard: { rule: "midRestartHead", value: `${ev.n} 遍起头「${ev.phrase}」`, limit: "结构证据在，禁止静默整段删" },
                  question: `模型判这句是片头寒暄，但句内「${ev.phrase}」起了 ${ev.n} 遍，正文在最后一遍里。整段删还是只删前面作废的几遍？`,
                  options: [
                    ...(headCut ? [{ label: "只删前几遍（保留最后一遍）", cuts: [[x.s, ev.keepAt]] }] : []),
                    { label: "整段删", cuts: [[x.s, x.e]] },
                    { label: "保留", cuts: [] },
                  ],
                });
                continue;
              }
              // 三重护栏都没接住 → 即将整段删。但如果原句是完整问句（呼语 + 提问），保留。
              // 实测飞书 #0「李薇老师记忆力的提升，语文成绩就能够提升吗？」被拆段成
              // 「李薇老师」+「记忆力的提升…吗？」两个单元，模型只看前半个，判「片头仅报人名」删掉，
              // 成片开场直接从「记忆力的提升」开始 —— 称呼是提问的一部分，不是寒暄。
              const _srcHead = RAW_SEGS[SEG[i].srcId]?.z || "";
              if (looksLikeAsk(_srcHead)) {
                console.log(`  ↷ 片头提问保护：保留 #${i}「${nzText(SEG[i].z).slice(0, 14)}」（原句是完整提问，称呼属提问的一部分）`);
                continue;
              }
            }
            if (SEG[i].srcId >= hN && SEG[i].srcId < RAW_SEGS.length - tN) {
              // 中段的提问不是跑题：问答体里它就是内容的骨架，删了回答会变成没头没尾。
              if (looksLikeQuestion(SEG[i].z)) {
                // 问句里带前导卡壳时，只删卡壳、保留完整问法（比整句保留更干净）
                const qp = repeatPrefixCut(SEG[i]);
                if (qp) {
                  console.log(`  ✂ 问句前导卡壳：删「${qp.del}」${(qp.b - qp.a).toFixed(2)}s，保留问句「${nzText(SEG[i].z).slice(qp.del.length, qp.del.length + 16)}…」`);
                  picked.push({
                    i, label, keepId: null,
                    reason: `${it.reason || "判为离题内容"} · 只删前导卡壳，问句保留`,
                    cutRange: [qp.a, qp.b], cutText: qp.del,
                  });
                  continue;
                }
                console.log(`  ↷ 提问保护：保留 #${i}「${nzText(SEG[i].z).slice(0, 16)}」（问答体的提问是内容骨架）`);
                // 但「模型判它跑题」这件事不能就这么吞掉 —— 用户要的是"要么删、要么标记"。
                // 实测飞书 #16「补充一点，我们的借款怎么可以怎么练习这个？」：前后都是总结句，
                // 这句本身语义不通（ASR 把「记忆」听成「借款」），只因为有问号就被静默保留，
                // 成片里留着一句没人看得懂的过渡。改成进待确认，让人拍板。
                const _qSrc = RAW_SEGS[SEG[i].srcId] || SEG[i];
                pushReview({
                  kind: "offtopic-question", priority: 2, s: _qSrc.s, e: _qSrc.e, segId: i,
                  text: nzText(_qSrc.z).slice(0, 22), line: _qSrc.z,
                  llm: { verdict: "cut", reason: it.reason || "判为离题内容" },
                  guard: { rule: "questionKeep", value: "问句", limit: "问答体的提问是内容骨架，不自动删" },
                  question: `模型认为这句跑题，但它是问句（可能是设问，也可能是口误）。删还是留？`,
                  options: [{ label: "删除", cuts: [[_qSrc.s, _qSrc.e]] }, { label: "保留", cuts: [] }],
                });
                continue;
              }
              console.log(`  ↷ offtopic 位置护栏：保留 #${i}「${nzText(SEG[i].z).slice(0, 14)}」（中段跑题极少，多为论据）`);
              // 卡片的删除区间给**整句**，不是拆段单元。
              // 「跑题」是句子级的判断，模型指的是整句，不是恰好落在这个单元里的那半句。
              // 实测飞书 #16「补充一点，我们的借款怎么可以怎么练习这个？」被云端 ASR 切成
              // #45「做一点不同的地方」+ #46「这么可以这么练习的功课」两个单元，只有前半被
              // 判 offtopic；卡片若只给前半（1.31s），用户点「删除」后成片里剩下的
              // 「这么可以这么练习的功课」就是一段没头没尾的断音 —— 旧版正是这么留下碎片的
              // （旧版卡片给 [99.02,103.441]+[103.596,104.007] 两刀，还切在「么」「习」字中间）。
              const _src = RAW_SEGS[SEG[i].srcId] || SEG[i];
              pushReview({
                kind: "offtopic-mid", priority: 1, s: _src.s, e: _src.e, segId: i,
                text: nzText(_src.z).slice(0, 22), line: _src.z,
                llm: { verdict: "cut", reason: it.reason || "判为离题内容" },
                guard: { rule: "offtopicPos", value: i, limit: `只允许片头${hN}句/片尾${tN}句` },
                question: `模型认为这句跑题，但它在中段（多半是论据）。删掉会少一段支撑，删还是留？（删除按整句算：${(_src.e - _src.s).toFixed(1)}s）`,
                options: [{ label: "删除", cuts: [[_src.s, _src.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // 重来版保护（确定性）：同一句说了两遍时，后一遍是最终要保留的版本。
          // 实测 C0779：LLM 把「当你管住了自己的表情」（重来版的第一句）判成"与前句重复起头"删掉，
          // 反而留下前一遍的半截，成片语义断裂。凡 DUP_HEAD 里的句子一律不删。
          if (DUP_HEAD.has(SEG[i].srcId)) {
            console.log(`  ↷ 重来版保护：保留 #${i}「${nzText(SEG[i].z).slice(0, 12)}」，它是同一句重说的最终版本`);
            continue;
          }
          const sg = SEG[i];
          // ── 收尾呼应护栏（确定性）──
          // 口播视频常用"总—分—总"：结尾会把开场的总起句再说一遍。那是**结构**，不是口误。
          // 实测 c2：「如果是以上情况之一，都特别的适合」被 qwen 判成"与第 0 句重复"删掉，
          // 但第 6 句正是全片落点 —— 删了之后视频说完五个类型就戛然而止，没有收束。
          // 判据：落在全片后 30%、且与开场前两句有 ≥8 字公共片段 → 视为呼应，保留。
          if (SEG[i].srcId >= RAW_SEGS.length * 0.7) {
            const cur = nzText(sg.z);
            const heads = RAW_SEGS.slice(0, 2).map((x) => nzText(x.z)).filter(Boolean);
            const echoed = heads.some((h) => {
              for (let L = Math.min(12, cur.length, h.length); L >= 8; L--) {
                for (let k = 0; k + L <= cur.length; k++) {
                  if (h.includes(cur.slice(k, k + L))) return true;
                }
              }
              return false;
            });
            if (echoed) {
              console.log(`  ↷ 收尾呼应护栏：保留 #${i}「${cur.slice(0, 14)}」（与开场同构，是总结句不是口误）`);
              pushReview({
                kind: "echo-tail", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: cur.slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为与开场重复" },
                guard: { rule: "closingEcho", value: "与开场有≥8字公共片段", limit: "后30%视为收尾呼应" },
                question: `模型说这句和开场重复，但它出现在结尾（像是总结句）。删还是留？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          if (sg.e - sg.s > (RS.maxSegSec ?? 20)) continue;
          if (label === "slip" && nzText(sg.z).length > (RS.slipMaxChars ?? 16)) {
            const pc = slipPrefixCut(sg);
            if (!pc) {
              // 兜底：下一句原样说出了本句中间的一段 → 本句是前一遍，整句删
              const tc = coveredByNext(i);
              if (tc) {
                console.log(`  ✂ 长 slip 整句删：「${tc.frag}」已由 #${tc.nextId} 完整重说（${(sg.e - sg.s).toFixed(1)}s）`);
                picked.push({ i, label, keepId: tc.nextId, reason: `${it.reason || ""} · 结尾被下一句完整重说` });
                continue;
              }
              // 第三兜底：段内同一 5 字短语重复 ≥3 次，且 keepId 指向后面的句段 → 整句是连卡版
              const kRaw = it.keepId == null ? null : Number(it.keepId);
              const kOk = Number.isInteger(kRaw) && kRaw > i && kRaw < SEG.length && !!nzText(SEG[kRaw].z);
              const rp = kOk ? repeatedPhrase(i) : null;
              if (rp) {
                console.log(`  ✂ 长 slip 整句删：「${rp}」在句内重复 ≥3 次，最终版在 #${kRaw}（${(sg.e - sg.s).toFixed(1)}s）`);
                picked.push({ i, label, keepId: kRaw, reason: `${it.reason || ""} · 段内短语重复≥3次` });
                continue;
              }
              // 第四兜底：段首一小截作废后，同一 ≥7 字短语从段内重来 → 只删前半
              const rh = kOk ? repeatedHead(i) : null;
              if (rh) {
                const ts = [];
                for (const w of sg.w || []) for (const _ of nzText(w[2])) ts.push(w[0]);
                if (ts.length >= rh.text.length) {
                  const cutAt = ts[rh.cutChars];
                  if (cutAt - sg.s >= 0.3 && cutAt - sg.s <= 12) {
                    console.log(`  ✂ 长 slip 段内重来：删前半「${rh.text.slice(0, rh.cutChars)}」${(cutAt - sg.s).toFixed(2)}s，保留从「${rh.frag}」起的重来版`);
                    picked.push({
                      i, label, keepId: kRaw,
                      reason: `${it.reason || ""} · 段内重来（公共短语「${rh.frag}」）`,
                      cutRange: [sg.s, cutAt], cutText: rh.text.slice(0, rh.cutChars),
                    });
                    continue;
                  }
                }
              }
              // 第五兜底：末分句「及物动词 + 数量/语气词」悬空，下一句紧接着补全 → 只删这一个分句。
              // 实测 #6「…有人能够在1个小时之内记住几百个」共 71 字，前 49 字（圆周率背到十万位）
              // 完全正确，整句删会把论据一起丢掉 —— 这也是用户不敢点「整段删」的原因。
              const dt = DANGLING.find((d) => d.segId === SEG[i].srcId && !d.wholeSeg &&
                d.s >= SEG[i].s - 0.02 && d.e <= SEG[i].e + 0.02);
              if (dt) {
                console.log(`  ✂ 长 slip 末尾分句：删「${dt.text}」${(dt.e - dt.s).toFixed(2)}s（「${dt.verb}」后只剩${dt.tail ? `「${dt.tail}」` : "空"}，由「${dt.nextText.slice(0, 14)}…」补全）`);
                picked.push({
                  i, label, keepId: kOk ? kRaw : null,
                  reason: `${it.reason || ""} · 末尾分句动词悬空`,
                  cutRange: [dt.s, dt.e], cutText: dt.text, tailCut: true,
                });
                continue;
              }
              // 第六兜底：问句的短前导卡壳 —— 只删卡壳，保留完整问法。
              // 实测 C0853 #13「呃，老师那到底呃呃老师你这个到底是什么方法呢？」：
              // 模型判 slip（21 字 > 16 且找不到重复锚点），旧逻辑只能整段交人判；
              // 而它真正该做的是删掉前 2.7s 的"呃老师那到底呃呃"。
              const qp = looksLikeQuestion(sg.z) ? repeatPrefixCut(sg) : null;
              if (qp) {
                console.log(`  ✂ 问句前导卡壳：删「${qp.del}」${(qp.b - qp.a).toFixed(2)}s，保留问句「${nzText(sg.z).slice(qp.del.length, qp.del.length + 16)}…」`);
                picked.push({
                  i, label, keepId: null,
                  reason: `${it.reason || "判为口误"} · 只删前导卡壳，问句保留`,
                  cutRange: [qp.a, qp.b], cutText: qp.del,
                });
                continue;
              }
              console.log(`  ↷ 跳过 slip（${nzText(sg.z).length} 字 > ${RS.slipMaxChars ?? 16}，且找不到重复锚点）：${nzText(sg.z).slice(0, 20)}…`);
              // 队列给三档而不是两档：「整段删」把 10 秒正确内容和口误绑在一起，
              // 用户只能选「保留」，等于这条判定白做（实测 3 条待确认里有 2 条是这样）。
              const _cls = clauseRanges(sg);
              // 末尾分句要比句首留下至少 1s 的正文才值得单独给出这一档 ——
              // 否则它和「整段删」是同一段区间，两档并列只会让人更犹豫。
              const _tail = _cls.length >= 2 && _tailRoom(_cls, sg) ? _cls[_cls.length - 1] : null;
              const _opts = [];
              if (_tail) _opts.push({ label: `只删末尾「${_tail.text.slice(-12)}」`, cuts: [[_tail.s, sg.e]] });
              _opts.push({ label: "整段删", cuts: [[sg.s, sg.e]] });
              _opts.push({ label: "保留", cuts: [] });
              pushReview({
                kind: "slip-noref", priority: 1, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为重说/口误" },
                guard: { rule: "slipMaxChars", value: nzText(sg.z).length, limit: RS.slipMaxChars ?? 16 },
                question: `模型说这句是重说，但 ${nzText(sg.z).length} 字太长、找不到可对齐的重复切口。${_tail ? `可以只删末尾「${_tail.text.slice(0, 14)}」，也可以整段删。` : "整句删还是留？"}`,
                options: _opts,
              });
              continue;
            }
            console.log(`  ✂ 句段内子切口：删前半「${pc.head}…」${(pc.b - pc.a).toFixed(2)}s，保留后半`);
            picked.push({ i, label, keepId: null, reason: `${it.reason || ""} · 句段内只删前一遍`, cutRange: [pc.a, pc.b], cutText: pc.del });
            continue;
          }
          // keepId 语义（v7）：slip / paraphrase 都应指向「最终保留的那一段」。
          // paraphrase 缺 keepId → 整条忽略（无法判断保留谁）；slip 缺 keepId → 允许（整句删）。
          let keepId = null;
          if (it.keepId != null) {
            const k = Number(it.keepId);
            const okK = Number.isInteger(k) && k > i && k < SEG.length &&
              SEG[k].s - sg.e <= (RS.paraphraseGapSec ?? 25) && !!nzText(SEG[k].z);
            if (okK) keepId = k;
            else if (label === "paraphrase") {
              // 只允许"删前保后"，指错方向就别剪 —— 但这是模型给了具体意见却没落地，交用户判
              console.log(`  ↷ 跳过 paraphrase（keepId=${it.keepId} 指向不成立）：${nzText(sg.z).slice(0, 14)}`);
              pushReview({
                kind: "paraphrase-dir", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: `${it.reason || "判为换说法"} · keepId=${it.keepId}` },
                guard: { rule: "paraphraseKeepId", value: String(it.keepId), limit: "必须指向后方且≤25s" },
                question: `模型说这句是前一遍说法（该留的是后面那句），但它指的位置对不上。删了会不会丢掉唯一一遍？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            } else if (label === "slip") {
              // slip 给了 keepId 却指不成立（实测 #2 的 keepId=1，指向自己前面那一句）。
              // 旧逻辑把 keepId 清空后照删本句 —— 方向正好相反：删掉最终版、留下卡壳版。
              // 模型既然说了"该留哪一句"，指错方向就不是"没给意见"，交人判。
              console.log(`  ↷ 跳过 slip（keepId=${it.keepId} 指向不成立）：${nzText(sg.z).slice(0, 14)}`);
              pushReview({
                kind: "slip-noref", priority: 1, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: `${it.reason || "判为口误"} · keepId=${it.keepId}` },
                guard: { rule: "slipKeepId", value: String(it.keepId), limit: "必须指向后方" },
                question: `模型说这句是口误、该留的是 #${it.keepId} 那句，但那个位置在本句前面。按它的意思删会把最终版删掉。删还是留？`,
                options: [{ label: "删除本句", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          } else if (label === "paraphrase") {
            console.log(`  ↷ 跳过 paraphrase（缺 keepId）：${nzText(sg.z).slice(0, 14)}`);
            pushReview({
              kind: "paraphrase-dir", priority: 2, s: sg.s, e: sg.e, segId: i,
              text: nzText(sg.z).slice(0, 22), line: sg.z,
              llm: { verdict: "cut", reason: it.reason || "判为换说法（未给保留句）" },
              guard: { rule: "paraphraseKeepId", value: "null", limit: "必须指向后方且≤25s" },
              question: `模型说这句是前一遍说法，但没指出该保留哪一句。删了会不会丢掉唯一一遍？`,
              options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
            });
            continue;
          }
          // 护栏⑦：paraphrase 的"被删那一遍"必须**自身够长够完整**。
          // 实测 C0779：ASR 把「孩子学不好，第一个要改的是家里的环境」切成两句，
          // 前半只有 5 字 / 0.86s，却被当成"前一遍"删掉 —— 成片直接从「效率越来越好」
          // 跳到「第一个要改的是家里的环境」，条件句丢了。几个字的半句本来就不构成一遍完整说法。
          if (label === "paraphrase") {
            const dn = nzText(sg.z).length, dd = sg.e - sg.s;
            if (dn < (RS.paraphraseMinChars ?? 8) || dd < (RS.paraphraseMinSec ?? 1.5)) {
              // 问句本来就短：它要么是内容（用户明确要求保留的提问），要么是半截假起头。
              // 两种情况都不值得弹卡问人 —— 保留的成本是 1 秒，弹卡的成本是每次都要做一次判断。
              if (looksLikeQuestion(sg.z)) {
                console.log(`  ↷ 提问保护：保留 #${i}「${nzText(sg.z).slice(0, 14)}」（问句不成句，按保留处理，不进待确认）`);
                continue;
              }
              console.log(`  ↷ 跳过 paraphrase（被删句仅 ${dn} 字 / ${dd.toFixed(2)}s，不成句）：${nzText(sg.z).slice(0, 16)}`);
              pushReview({
                kind: "paraphrase-short", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为前一遍说法" },
                guard: { rule: "paraphraseMin", value: `${dn}字/${dd.toFixed(2)}s`, limit: `${RS.paraphraseMinChars ?? 8}字/${RS.paraphraseMinSec ?? 1.5}s` },
                question: `模型说这句是前一遍，但它只有 ${dn} 字、${dd.toFixed(2)}s，可能只是个半句。删还是留？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // 护栏⑧：前件保护。keepId 那句以「第一个/首先/那么/而/因为…」开头时，
          // 它是后件的引导，被删句是它的前件而不是旧说法。
          if (keepId != null) {
            const kt = nzText(SEG[keepId].z);
            if (DEP_START.test(kt)) {
              console.log(`  ↷ 前件保护：保留 #${i}「${nzText(sg.z).slice(0, 12)}」，因为保留句 #${keepId} 以「${kt.slice(0, 3)}」开头，依赖本句作前件`);
              pushReview({
                kind: "dep-keep", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为前一遍说法" },
                guard: { rule: "depStart", value: `#${keepId} 以「${kt.slice(0, 3)}」开头`, limit: "前件保护" },
                question: `模型说这句多余，但后面那句以「${kt.slice(0, 3)}」开头，靠它当前件。删了会不会断逻辑？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // ── slip 的重说证据（确定性，2026-11-05）──
          // slip 是"同一个意思说了两遍，前一遍没说对"，它必须靠**文本里能看到两版措辞**成立，
          // 而不是靠模型在 reason 里用了哪个词。旧实现拿 8 个关键词（转写/病句/读不通…）去猜，
          // 判据挂在模型的用词上：同一条 C0853 #3，一次写"明显转写错误"被拦成卡片，另一次写
          // "明显口误：'可劳'应为'可能'"就整段删掉 3.02s —— 两次最长公共串都是 2、句子一字不差。
          // 而且失效是 fail-open 且无痕：不写日志、不进队列，事后和"模型判 ok"分不出来。
          // 现在不看措辞，只看结构，三条任一成立即放行：
          //   ① 与保留句有 ≥6 字连续公共串 —— 同一句被重说；
          //   ② 本句内部有 ≥4 字重复片段 —— 说了一半又从头来；
          //   ③ 与保留句开头有 ≥4 字公共前缀 —— 同一句从头重说。
          // 三条都不成立 → 证据不足 → 待确认（不再静默删除）。
          // 完整问句仍按原规则静默保留：提问是内容骨架，与保留句无公共措辞时那是另一句提问。
          if (label === "slip") {
            const raw = String(sg.z || "").trim();
            const a1 = nzText(raw);
            const b1 = keepId != null ? nzText(SEG[keepId].z) : "";
            if (/[？?]$/.test(raw) && keepId != null && lcsLen(a1, b1) < 4) {
              console.log(`  ↷ slip 措辞护栏：保留 #${i}「${a1.slice(0, 14)}」（完整问句且与保留句无公共措辞，是另一句提问）`);
              continue;
            }
            const ev = slipEvidence(a1, b1);
            if (!ev.ok) {
              // 11-04 起这里不再静默 continue：模型说该删、代码不删，必须让人看见并拍板。
              console.log(`  ? slip 重说证据不足：待确认 #${i}「${a1.slice(0, 14)}」（公共串 ${ev.run} 字 / 句内重复 ${ev.rep} 字 / 开头重合 ${ev.pre} 字）`);
              pushReview({
                kind: "slip-weak", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: a1.slice(0, 22), line: raw,
                llm: { verdict: "cut", reason: it.reason || "判为口误" },
                guard: { rule: "slipEvidence", value: `run=${ev.run} rep=${ev.rep} pre=${ev.pre}`, limit: `需 ≥${SEV.minRun} 字公共串 / ≥${SEV.minSelfRepeat} 字句内重复 / ≥${SEV.minPrefix} 字开头重合` },
                question: `模型说这句是口误、该删；但文本里找不到重说的证据 —— 和保留句没有 ${SEV.minRun} 字以上相同片段，本句也没有重复起头。删还是留？`,
                // options 必须有：clipReviewItems 用 options[].cuts 算卡片区间，
                // 缺了会被当成"落在已剪区间"静默剔除（踩过一次，卡片凭空消失）。
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // 问句被判「换说法」时同样要证据（2026-11-04）：提问是内容的骨架，而模型会把相邻的
          // 两个不同提问读成"同一句的两种说法"。实测 C0853 #11「那老师您这个方法在哪里学呢」
          // 被判 paraphrase（keepId=#12「你老师到底有什么方法」），两句只有"方法"两字相同——
          // 删掉的是"在哪学"，留下的是"有什么方法"，不是同一件事。零重叠时进待确认，不静默删。
          if (label === "paraphrase" && keepId != null && looksLikeQuestion(sg.z)) {
            const lq = lcsLen(nzText(sg.z), nzText(SEG[keepId].z));
            if (lq < 4) {
              console.log(`  ? 问句换说法证据不足：待确认 #${i}「${nzText(sg.z).slice(0, 14)}」（与保留句仅 ${lq} 字重合）`);
              pushReview({
                kind: "paraphrase-weak", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nzText(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为换说法" },
                guard: { rule: "paraphraseEvidence", value: `LCS=${lq}`, limit: "问句需 ≥4 字公共措辞" },
                question: `模型说这句和后面那句是同一个意思，但两句只重合 ${lq} 字。删了会不会丢掉一个不同的提问？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          picked.push({ i, label, keepId, reason: it.reason || "" });
        }
        picked.sort((a, b) => a.i - b.i);
        const segDur = (p) => p.cutRange ? (p.cutRange[1] - p.cutRange[0]) : (SEG[p.i].e - SEG[p.i].s);
        // 护栏⑤：连续 slip / paraphrase 视为"同一处重复的多次尝试"，**只保留最后一遍**。
        // 旧规则（连续 slip 只删前一句）会留下中间那一遍：C0779 三遍带货话术删到只剩 2 遍就是这个原因。
        // 口误/重说的语义永远是"删前保后"，所以链尾一律保留、链上前面的全删。
        const RUN_CUT = new Set(["slip", "paraphrase"]);
        const chainOk = [];
        for (let k = 0; k < picked.length; k++) {
          const p = picked[k];
          if (!RUN_CUT.has(p.label)) { chainOk.push(p); continue; }
          let j = k;
          while (j + 1 < picked.length && picked[j + 1].i === picked[j].i + 1 && RUN_CUT.has(picked[j + 1].label)) j++;
          if (j > k) {
            // 链尾未必是"最完整的那一遍"：链内若有人标了 paraphrase 的 keepId，就以它为终点
            // （实测 C0793：链 #7–#12 的链尾是口误残句「各个科目的提高身的」，
            //   真正该保留的是 #11 指向的 #13「现在临近期中」）。
            let keepIdx = picked[j].i;
            for (let t = k; t <= j; t++) {
              const kp = picked[t].keepId;
              if (Number.isInteger(kp) && kp > keepIdx && nzText(SEG[kp]?.z)) keepIdx = kp;
            }
            for (let t = k; t <= j; t++) if (picked[t].i < keepIdx) chainOk.push({ ...picked[t], chain: true });
            console.log(`  ↷ 连续重说链 #${picked[k].i}–#${picked[j].i}：删前 ${j - k + 1} 句，只保留最后一遍 #${keepIdx}「${nzText(SEG[keepIdx].z).slice(0, 16)}」`);
            k = j;
          } else chainOk.push(p);
        }
        // 护栏⑥：被 slip/paraphrase 指定为"要保留的最终那一段"的句子，一律不许删
        const protectedIdx = new Set(
          chainOk.filter((p) => p.keepId != null).map((p) => p.keepId));
        const safePicked = chainOk.filter((p) => !protectedIdx.has(p.i));
        // 护栏⑦：逻辑续接。删除句的**下一句**若以「而是/但是/所以/因为/不过/而且…」开头，
        // 删掉前句会让后句失去依托。实测 C0779：删掉「所以很多时候不是孩子不争气」后，
        // 成片直接从「他的效率越来越低」跳到「而是家里的环境把他学习那种」，因果链断在半空。
        const BREAK_START = /^(而是|但是|但|所以|因为|不過|不过|而且|于是|於是|可是|然而|同时|同時|另外)/;
        const _del0 = new Set(safePicked.map((p) => p.i));
        const linkOk = safePicked.filter((p) => {
          let j = p.i + 1;
          while (j < SEG.length && _del0.has(j)) j++;
          if (j >= SEG.length) return true;
          const t = nzText(SEG[j].z);
          if (BREAK_START.test(t)) {
            console.log(`  ↷ 逻辑续接护栏：保留 #${p.i}「${nzText(SEG[p.i].z).slice(0, 12)}」，否则下一句「${t.slice(0, 10)}…」失去上文`);
            pushReview({
              kind: "logic-link", priority: 2, s: SEG[p.i].s, e: SEG[p.i].e, segId: p.i,
              text: nzText(SEG[p.i].z).slice(0, 22), line: SEG[p.i].z,
              llm: { verdict: "cut", reason: p.reason || "判为多余" },
              guard: { rule: "breakStart", value: t.slice(0, 6), limit: "下一句以转折/因果连词开头" },
              question: `删掉这句后，下一句会以「${t.slice(0, 4)}」开头、失去上文。删还是留？`,
              options: [{ label: "删除", cuts: [[SEG[p.i].s, SEG[p.i].e]] }, { label: "保留", cuts: [] }],
            });
            return false;
          }
          return true;
        });
        // 护栏②：连续删除上限（重说链除外）
        // 链内每一句都指向同一个 keepId＝同一处重复，整链该删干净；若也计入连续上限，
        // 会在链中间留下一两句"漏网的重复遍"（实测 C0793 链长 10 句时保留了一句残句）。
        const MAXRUN = RS.maxRun ?? 6;
        const keepRun = [];
        let run = 0;
        for (const p of linkOk) {
          if (p.chain) { keepRun.push(p); continue; }
          run = keepRun.length && p.i === keepRun[keepRun.length - 1].i + 1 ? run + 1 : 1;
          if (run <= MAXRUN) keepRun.push(p);
          else console.log(`  ⚠️ 连续 ${run} 句被判删，超过上限 ${MAXRUN}，保留第 ${p.i} 句`);
        }
        // 护栏①：总时长上限
        // 口径：分母是全片，分子只算语义通道自己的判定。结构路由的句段不归这条断路器管 ——
        // 它们是确定性的、可复核的，混进来等于让"防 LLM 犯错"的护栏去限制确定性通道。
        let cutDur = keepRun.reduce((a, p) => a + segDur(p), 0);
        const cap = rawDur * (RS.maxRatio ?? 0.35);
        let final = keepRun;
        if (cutDur > cap) {
          console.log(`  ⚠️ 判定删除 ${cutDur.toFixed(1)}s 超过上限 ${cap.toFixed(1)}s，整批不剪（防误删）`);
          pushReview({
            kind: "batch-over", priority: 1, s: 0, e: rawDur, segId: -1,
            text: `模型判定删除 ${cutDur.toFixed(1)}s（${(cutDur / rawDur * 100).toFixed(0)}%）`,
            line: keepRun.map((p) => nzText(SEG[p.i].z).slice(0, 10)).join(" / ").slice(0, 120),
            llm: { verdict: "cut", reason: `共 ${keepRun.length} 句` },
            guard: { rule: "maxRatio", value: `${(cutDur / rawDur * 100).toFixed(0)}%`, limit: `≤${((RS.maxRatio ?? 0.35) * 100).toFixed(0)}%` },
            question: `这一批判定要删 ${cutDur.toFixed(1)}s，超过全片 ${((RS.maxRatio ?? 0.35) * 100).toFixed(0)}% 的保护线，已全部保留。是否按模型意见删掉？`,
            options: [
              { label: "保持不剪", cuts: [] },
              { label: "按模型全删", cuts: keepRun.map((p) => (p.cutRange ? p.cutRange : [SEG[p.i].s, SEG[p.i].e])) },
            ],
          });
          final = [];
        }
        // 护栏⑧：段内前缀重说保护 —— 撤掉整段删。
        // 一个句段里"说半句 → 停 0.5s → 从头完整重说"时，语义通道只看得见整段，
        // 往往判 paraphrase 把**两遍一起删掉**，连重来版的完整句也没了。
        // 实测飞书 #21（127.85–137.63，9.8s）：
        //   「那很多人只会死劲背啊，哪怕是写了很多次这个月 那很多人只会死劲背，
        //    哪怕是写了很多次作文依然记不住，依然不会写」
        // 模型判 paraphrase、理由「内容已被后文覆盖」，一刀 9.8s 把正确的那一遍也删了。
        // 正确删法由 detectPrefixRestarts 给（只删前一遍），这里只负责撤掉整段删。
        if (process.env.XUNJIAN_PREFIX_RESTART !== "off") {
          const prGuard = detectPrefixRestarts(RAW_SEGS, R.retake?.prefixRestart || {});
          if (prGuard.cuts.length) {
            const prSrc = new Set();
            for (const h of prGuard.report) {
              const sid = RAW_SEGS.findIndex((x) => x.s <= h.s + 0.05 && x.e >= h.e - 0.05);
              if (sid >= 0) prSrc.add(sid);
            }
            const _n1 = final.length;
            final = final.filter((p) => {
              if (p.cutRange) return true;                     // 子切口只删半句，不冲突
              if (!prSrc.has(SEG[p.i].srcId)) return true;
              console.log(`  ↷ 前缀重说保护：撤掉 #${p.i}「${nzText(SEG[p.i].z).slice(0, 14)}」的整段删（段内说了两遍，后一遍是完整版；由前缀重说通道只删前一遍）`);
              return false;
            });
            if (final.length !== _n1) {
              // 撤掉的是整句删，cutDur 要跟着重算，否则「判定删除 X 句（Ys）」与实际不符
              cutDur = final.reduce((a, p) => a + segDur(p), 0);
              console.log(`  ↷ 撤销 ${_n1 - final.length} 处整段删（删除总时长改为 ${cutDur.toFixed(1)}s）`);
            }
          }
        }
        // 残片回收：≤2 字、且前后句都被删的孤立碎片，一并删（它们是被删句的尾巴）
        const cutIdx = new Set(final.map((p) => p.i));
        for (let grew = true; grew;) {
          grew = false;
          for (let j = 1; j < SEG.length - 1; j++) {
            if (cutIdx.has(j) || nzText(SEG[j].z).length > 2) continue;
            if (cutIdx.has(j - 1) && cutIdx.has(j + 1)) {
              cutIdx.add(j);
              final.push({ i: j, label: "fragment", keepId: null, reason: "被删句之间的孤立残片" });
              grew = true;
            }
          }
        }
        final.sort((a, b) => a.i - b.i);
        const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
        console.log(`  判定删除 ${final.length}/${SEG.length} 句（${cutDur.toFixed(1)}s）`);
        for (const p of final)
          console.log(`    ⌫ [${fmtT(p.cutRange ? p.cutRange[0] : SEG[p.i].s)}${p.cutRange ? `~${(p.cutRange[1] - p.cutRange[0]).toFixed(2)}s` : ""}] ${p.label}${p.keepId != null && !p.tailCut ? `→保留#${p.keepId}` : ""}${p.tailCut ? "（同句其余分句保留）" : ""}「${p.cutText || nzText(SEG[p.i].z)}」${p.reason ? " · " + p.reason : ""}`);
        rs = {
          // 整句删 → 走静音吸附；句段内子切口 → 切口落在词间，吸附会把后半正确内容吞掉，故原样保留
          cuts: final.filter((p) => !p.cutRange).map((p) => [SEG[p.i].s, SEG[p.i].e]),
          subCuts: final.filter((p) => p.cutRange).map((p) => p.cutRange),
          report: final.map((p) => ({
            s: p.cutRange ? p.cutRange[0] : SEG[p.i].s,
            e: p.cutRange ? p.cutRange[1] : SEG[p.i].e,
            cut: p.cutText ? p.cutText : nzText(SEG[p.i].z),
            kept: p.cutRange ? "（同句其余分句保留）" : (p.keepId != null ? nzText(SEG[p.keepId].z) : "（语义冗余，删除）"),
            reason: `语义扫描：${p.label}${p.reason ? " · " + p.reason : ""}`,
          })),
        };
      } else console.log("  ⚠️ 语义扫描裁决不可用，跳过");
    }
    // ── 段内多次起头：一句话被自己打断两三遍，ASR 并成了一个长句段 ──
    // 与上面那条互补：那条要 LLM 先判 slip，模型把"四遍连读"看成一句读得通的话时就整个漏掉
    // （实测 c1 #14：61.59–78.01 / 78 字 / 16.4s，四遍起头，间隙 0.35/0.66/0.35s 全在 VAD
    //  切句阈值以下，语义扫描判 ok，三类假起头也要求重来点贴段首 → 一字未剪）。
    // 这里改成「确定性命中候选 + LLM 只判哪几段作废」：候选条件是同一 ≥5 字短语跨起头复现，
    // 正常口播段几乎不出现（实测该片 19 句只命中 1 句），所以最多多花一次裁决调用。
    let mr = { cuts: [], report: [] };
    if (ASR_PROVIDER === "cloud" && process.env.XUNJIAN_INNER_RESTART !== "off" && arbiterOk("inner-restart")) {
      const MID = R.stutter.midRestart || {};
      const cands = detectMidRestarts(rawSegs, {
        pauseSec: MID.pauseSec, minAttempts: MID.minAttempts,
        minRepeatChars: MID.minRepeatChars, minChars: MID.minChars,
      });
      if (cands.length) {
        step(`段内多次起头（${LLM_MODEL}，${cands.length} 处候选）`);
        const plainMR = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
        const v = adjudicate("inner-restart", {
          segments: cands.map((c) => ({
            id: c.segId, s: c.s, e: c.e, text: c.text,
            prev: plainMR((rawSegs[c.segId - 1] || {}).z).slice(-20),
            next: plainMR((rawSegs[c.segId + 1] || {}).z).slice(0, 20),
            attempts: c.attempts.map((x) => ({ id: x.id, s: x.s, e: x.e, text: x.text })),
          })),
        });
        const verdicts = (v && Array.isArray(v.verdicts)) ? v.verdicts : [];
        if (!verdicts.length) console.log("  ⚠️ 多次起头裁决不可用，本次不动刀");
        const byId = new Map(cands.map((c) => [c.segId, c]));
        for (const it of verdicts) {
          const c = byId.get(Number(it && it.id));
          if (!c) continue;
          // 结构通道是这些句段的唯一裁决方：它若最终没删，要看一眼影子判决，
          // 否则"模型说要删、起头通道说保留"这件事没有任何痕迹。
          const sh = STRUCT_SHADOW.get(c.segId);
          const shTip = sh ? `（影子：语义通道判「${sh.label}」，${String(sh.reason || "").slice(0, 24)}）` : "";
          const res = applyMidRestartVerdict(c, it.drop, MID);
          if (res.ignored.length) console.log(`   · 起头通道忽略 id ${res.ignored.join(",")}（末段保护 / 首段没有废起头证据）`);
          if (res.blocked.length) { console.log(`  ⚠️ 多次起头护栏拦下 #${c.segId}：${res.blocked.join("、")}${shTip}`); continue; }
          if (!res.cuts.length) { console.log(`  ✓ 多次起头 #${c.segId}：未标作废起头，原样保留${shTip}`); continue; }
          mr.cuts.push(...res.cuts);
          mr.report.push(...res.report);
          for (const r of res.report)
            console.log(`  ✂ 多次起头：删「${r.cut}」${(r.e - r.s).toFixed(2)}s → 保留「${r.kept}」`);
        }
        // 候选 + 裁决 + 落地结果一起落盘：复核"这句为什么剪/为什么没剪"全靠它
        try {
          fs.writeFileSync(path.join(EP, "work/inner-restart.json"),
            JSON.stringify({ candidates: cands, verdicts, cuts: mr.cuts }, null, 1));
        } catch (e) { console.log(`  ⚠️ 多次起头明细写入失败: ${e.message}`); }
      }
    }
    // ── 跨句尾首重说（确定性，不看模型标签）──
    // 前句尾部说了半截、后句从同一短语重新起头，ASR 把两遍切成了相邻两句：
    // 实测 C0777 #7 结尾「…钻得进去，相反的一个脾气。」→ 停 2.22s → #8 开头「相反的一个脾气一点就着…」。
    // detectRetakes 只看整句相似 / 后句以前句开头 / 开头 LCP，这组整句相似度 0.078、LCP 0；
    // detectMidRestarts 只看段内；detectInnerRetakes 只看段首 —— 三边都不认领，成片会连着听两遍。
    // 判据见 retake.mjs 的 detectTailHeadRestarts；切口落在字间，走 subCuts，不做静音吸附。
    const th = { subCuts: [], report: [] };
    if (process.env.XUNJIAN_TAIL_HEAD !== "off") {
      const TH = R.retake?.tailHead || {};
      const takenT = [...rt.cuts, ...st.cuts, ...mr.cuts, ...fl.cuts, ...f2.cuts, ...(rs.cuts || []), ...(rs.subCuts || [])];
      const tailHits = detectTailHeadRestarts(rawSegs, TH);
      for (const h of tailHits.report) {
        if (takenT.some(([a, b]) => h.s < b - 0.05 && h.e > a + 0.05)) continue;
        th.subCuts.push([h.s, h.e]);
        th.report.push({ s: h.s, e: h.e, cut: h.cut, kept: h.kept, reason: h.reason });
        console.log(`  ✂ 跨句尾首重说：删「${h.cut}」${(h.e - h.s).toFixed(2)}s → 保留「${h.kept.slice(0, 16)}」`);
      }
    }
    // ── 段内前缀重说（确定性，不看模型标签）──
    // 一句话说了两遍、前一遍是废稿。最常见的情形：说了半句 → 停 0.5s → 从头完整重说。
    // detectInnerRetakes 只找段首 12 字内的重来点，detectMidRestarts 要求至少 3 次起头
    // —— 2 次起头、重来点落在第 21 字的这种，两边都不认领。
    // 实测飞书 #21（127.85–137.63，50 字 / 9.8s）：
    //   「那很多人只会死劲背啊 哪怕是写了很多次这个月」      ← 卡在「这个月」的废稿
    //   停 0.54s
    //   「那很多人只会死劲背 哪怕是写了很多次作文依然记不住依然不会写」  ← 完整版
    // 判据见 retake.mjs detectPrefixRestarts。全库 100 份素材命中 3 处（含同一素材两个副本、
    // C0820「但是很多人只会死劲硬」），排比/递进过不了「前遍被后遍覆盖」这一关。
    const pr = { subCuts: [], report: [] };
    if (process.env.XUNJIAN_PREFIX_RESTART !== "off") {
      // 只跟「已经在它之前算好的」通道去重：qc / dc 在本块之后才生成，
      // 反过来由它们的 taken 列表带上 pr.subCuts（同一条切口不会被切两次）。
      const takenP = [...rt.cuts, ...st.cuts, ...mr.cuts, ...th.subCuts, ...fl.cuts, ...f2.cuts,
        ...(rs.cuts || []), ...(rs.subCuts || [])];
      for (const h of detectPrefixRestarts(rawSegs, R.retake?.prefixRestart || {}).report) {
        if (takenP.some(([a, b]) => h.s < b - 0.05 && h.e > a + 0.05)) continue;
        pr.subCuts.push([h.s, h.e]);
        pr.report.push({ s: h.s, e: h.e, cut: h.cut, kept: h.kept, reason: h.reason });
        console.log(`  ✂ ${h.reason}（${(h.e - h.s).toFixed(2)}s）→ 保留「${h.kept.slice(0, 16)}」`);
      }
    }
    // ── 问句结构切口（确定性，不看模型标签）──
    // 两类句子语义通道只能判 ok、三层兜底也接不住，判据见 question-cut.mjs 顶部。
    // 模型在这两类上极不稳定：同一条 C0853 #10，11-03 16:03 那次判 offtopic（被 offtopicPos
    // 拦下推待确认），11-04 18:21 那次判 ok（理由"是下一句的前件"）——两次都不删。
    // 所以这里不参考 verdict，命中即剪；若同段另有 offtopic 待确认卡，卡片会因落在
    // 已剪区间被 clipReviewItems 剔除（与分句悬空同一套处理）。
    const qc = { cuts: [], subCuts: [], report: [] };
    if (process.env.XUNJIAN_QUESTION_CUT !== "off") {
      const QC = R.stutter?.questionCut || {};
      const takenQ = [...rt.cuts, ...st.cuts, ...mr.cuts, ...th.subCuts, ...pr.subCuts, ...fl.cuts, ...f2.cuts, ...(rs.cuts || []), ...(rs.subCuts || [])];
      for (const h of detectQuestionHeadFrags(rawSegs, QC)) {
        if (takenQ.some(([a, b]) => h.s < b - 0.05 && h.e > a + 0.05)) continue;
        qc.cuts.push([h.s, h.e]);
        qc.report.push({
          s: h.s, e: h.e, cut: h.text, kept: "（半截问句，下一句重新提问）",
          reason: `半截问句：句末停在「什么样的」，${h.gap}s 后重新问「${h.nextText.slice(0, 14)}」`,
        });
        console.log(`  ✂ 半截问句：删「${h.text}」${(h.e - h.s).toFixed(2)}s（${h.gap}s 后重新提问）`);
      }
      for (const p of detectQuestionPrefixRestarts(rawSegs, QC)) {
        qc.subCuts.push([p.s, p.e]);
        qc.report.push({ s: p.s, e: p.e, cut: p.cut, kept: p.kept, reason: p.reason });
        console.log(`  ✂ 问句前缀卡壳：删「${p.cut}」${(p.e - p.s).toFixed(2)}s → 保留「${p.kept.slice(0, 16)}」`);
      }
    }
    // ── 分句悬空：不依赖 LLM 判定的直接剪除 ──
    // 上面那条只处理"LLM 已判 slip 但整段太长"的情况；实测 #7 更糟：模型把整段判成 ok，
    // 因为「…记住335个单词」把整句撑得成立，句内那个「有人能够一遍记住啊」它根本没看见。
    // 判据本身是确定性的（动词后只剩数量/语气词 + 下一分句同动词补全），
    // 全库 101 个工程 / 3978 个分句只命中这 2 处，不会误伤，所以命中即剪。
    const dc = { cuts: [], subCuts: [], report: [] };
    if (process.env.XUNJIAN_DANGLING !== "off") {
      const taken = [...rt.cuts, ...st.cuts, ...mr.cuts, ...th.subCuts, ...pr.subCuts, ...fl.cuts, ...f2.cuts, ...(rs.cuts || []), ...(rs.subCuts || []), ...qc.cuts, ...qc.subCuts];
      for (const d of DANGLING) {
        if (d.wholeSeg) continue;   // 整句悬空走整句删除路径，不在这里擅自整段删
        if (taken.some(([a, b]) => d.s < b - 0.05 && d.e > a + 0.05)) continue;
        dc.subCuts.push([d.s, d.e]);
        dc.report.push({
          s: d.s, e: d.e, cut: d.text, kept: "（同句其余分句保留）",
          reason: `分句悬空：「${d.verb}」后只剩「${d.tail}」，由下一分句「${d.nextText.slice(0, 12)}」补全`,
        });
        console.log(`  ✂ 分句悬空：删「${d.text}」${(d.e - d.s).toFixed(2)}s（#${d.segId}.${d.clauseIdx}，下一分句补全）`);
      }
    }
    // ── 短起头残片（拆段视图，确定性）──
    // 拆段之后才看得见的一类：≤5 字的断头话，后面 1.5s 内从同一个开头重说。
    // 语义通道只能判 ok（它是后句的前件），LCP 判据要求 ≥6 字连续重合又够不着，
    // 于是三边都不认领。判据见 headfrag.mjs；全库 35 份实测 5 处。
    const hf = { cuts: [], report: [] };
    if (process.env.XUNJIAN_HEAD_FRAG !== "off") {
      const takenH = [...rt.cuts, ...st.cuts, ...mr.cuts, ...th.subCuts, ...pr.subCuts, ...fl.cuts, ...f2.cuts,
        ...(rs.cuts || []), ...(rs.subCuts || []), ...qc.cuts, ...qc.subCuts, ...dc.subCuts];
      // 去重只认「已经被别人切掉的那部分」，不认「碰到一点边」。
      // 实测 C0777「那看到孩」[50.70,51.66]：冗余通道切的是 [51.6417,55.6051]，
      // 两段仅重叠 0.018s（同一条字边界上的取整差），旧的「任一相交就跳过」把整刀吞掉，
      // 结果 0.93s 的断头话留在成片开头，而它 0.66s 后就被「当孩子看到爸爸的脸是…」重说了。
      // 改成做减法：剩下的时长仍够一刀就切剩下的部分。
      for (const h of detectHeadFrags(SEG, R.split?.headFrag || {}).report) {
        const minCut = R.split?.headFrag?.minCutSec ?? 0.25;
        let rest = [[h.s, h.e]];
        for (const [a, b] of takenH) {
          const out = [];
          for (const [s, e] of rest) {
            if (b <= s || a >= e) { out.push([s, e]); continue; }
            if (a > s) out.push([s, a]);
            if (b < e) out.push([b, e]);
          }
          rest = out;
        }
        const keepParts = rest.filter(([s, e]) => e - s >= minCut);
        if (!keepParts.length) continue;   // 整段已被别的通道切干净，不算漏
        for (const [s, e] of keepParts) {
          hf.cuts.push([s, e]);
          hf.report.push({ s, e, cut: h.cut, kept: h.kept, reason: h.reason });
        }
        console.log(`  ✂ ${h.reason}${keepParts.length === 1 && Math.abs(keepParts[0][0] - h.s) < 0.02 && Math.abs(keepParts[0][1] - h.e) < 0.02 ? "" : `（去掉已被切掉的 ${(h.e - h.s - keepParts.reduce((x, [s, e]) => x + e - s, 0)).toFixed(2)}s）`}`);
      }
    }
    // ── 片头口令（确定性）──
    // 「那你先问呗」「你问题先问一下」这类对镜头外说的话，语义通道两次跑给了两个结论
    // （C0779 判 offtopic 删、C0777 判 ok 留），而它其实是纯结构问题：位置在最前、
    // 整句只说拍摄行为。判据见 openslate.mjs；全库 2 份素材命中、0 误报。
    const osl = { cuts: [], report: [] };
    if (process.env.XUNJIAN_OPEN_SLATE !== "off") {
      const o = detectOpenSlate(SEG, R.split?.openSlate || {});
      for (let i = 0; i < o.cuts.length; i++) {
        osl.cuts.push(o.cuts[i]);
        osl.report.push(o.report[i]);
        console.log(`  ✂ ${o.report[i].reason}`);
      }
    }
    const report = [...rt.report, ...st.report, ...mr.report, ...th.report, ...pr.report, ...fl.report, ...f2.report, ...rs.report, ...qc.report, ...dc.report, ...hf.report, ...osl.report];

    // 切口吸附到真实静音:whisper 的词边界会把停顿算进词长(实测偏差 0.7s 以上),
    // 直接按它切会在保留段里留下"几十~几百毫秒的残音碎片 + 一段孤立静音",
    // 成片转写会把碎片听成辅音并幻觉出一个不存在的词(实测切口处产出幻觉字幕「保护」)。
    // 做法:起点退回所在静音的开头;终点吞掉紧随其后的静音,并在下一段语音起点前留 tailProtectSec 保护。
    const SNAP = R.segment.snap;
    const fine = run(FFMPEG, ["-i", input, "-vn", "-af", `silencedetect=noise=${NOISE}dB:d=${SNAP.fineSilenceSec}`, "-f", "null", "-"]);
    const flog = fine.stderr || "";
    const fs0 = [...flog.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
    const fe0 = [...flog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
    const pauses = fs0.map((s, i) => [s, fe0[i] ?? rawDur]).filter(([s, e]) => e - s > R.segment.pauseMinSec);
    // 语音句段边界：吸附静音时用它兜底，防止把夹在中间的**语音**一并吞掉。
    // 实测坑（v3-C0779）：重说切口 [16.35,17.89] 的终点向前找静音时，跨过了 17.84-19.28 的正常语音，
    // 把「第一個該改的不是孩子」整句删掉（成片首句从「…我觉得孩子成绩不好第一个该改的不是孩子而是家里的环境」
    // 变成「…而是家里的环境」）。同理，若一段"静音"里其实夹着语音句段，则它不是纯静音，不可用于起点回退。
    const segBounds = (rawSegs || []).map((x) => [x.s, x.e]).sort((x, y) => x[0] - y[0]);
    // 语音起点表：句段界 + **字级起点**。
    // whisper 时代一句 5~6 秒、段界足够密，只看句段界就够；paraformer 的句段粗得多
    // （实测 c3 第 0 段跨 6.3s），语句内部没有任何"边界"可拦，于是语气词切口向后找静音时
    // 会跨过真实语音：实测 c3 切口 [2.25,2.54] 被吸成 [2.25,3.47]，把「客 观 承 认」整段吞掉。
    // 这里补一层字级起点判断 —— 只要静音段内出现任何一个字的起点，就不是纯静音。
    const wordStarts = (rawSegs || []).flatMap((x) => (x.w || []).map((w) => w[0])).sort((a, b) => a - b);
    const hasSpeechIn = (ss, se) => {
      const lo = ss + SNAP.speechGuardSec, hi = se - SNAP.speechGuardSec;
      if (hi <= lo) return false;
      if (segBounds.some(([bs]) => bs > lo && bs < hi)) return true;
      let a = 0, b = wordStarts.length;
      while (a < b) { const m = (a + b) >> 1; if (wordStarts[m] <= lo) a = m + 1; else b = m; }
      return a < wordStarts.length && wordStarts[a] < hi;
    };
    // 下一处语音的起点（句段界 ∪ 字级起点）。用于夹住切口终点。
    // 实测坑（qa-midrestart）：重说切口 [69.39,73.00] 向后吞静音时，silencedetect 把下一个字的
    // 起音（73.00–73.44 的「你」）判成了一小段静音，于是终点被推到 73.439，把保留句的句头
    // 「你会想到」整段吞掉，成片变成「…之前有没有寄过／类似的语文写作…」（丢了主语）。
    // 原来的 hasSpeechIn 只看「严格落在静音内部」的起点，起点正好压在静音开始时看不见。
    const firstSpeechAfter = (t) => {
      const lo = t - 0.02;   // 起点正好压在切口终点上（句段首尾相接）也要算进来
      let best = Infinity;
      for (const [bs] of segBounds) if (bs > lo && bs < best) best = bs;
      let a2 = 0, b2 = wordStarts.length;
      while (a2 < b2) { const m = (a2 + b2) >> 1; if (wordStarts[m] <= lo) a2 = m + 1; else b2 = m; }
      if (a2 < wordStarts.length && wordStarts[a2] < best) best = wordStarts[a2];
      return Number.isFinite(best) ? best : null;
    };
    // 整段切口收尾：终点不得落进「下一句保留句」里。
    // 起因：重说切口按 breatheSec 各外扩 0.05s，而 paraformer 的句段几乎首尾相接（gap=0），
    // [69.44,73.00] 直接变成 [69.39,73.05] —— 后 50ms 已经是 ASR 认定的下一句。
    // 注：本例实测能量起点在 73.43（73.00~73.43 是 −40dB 静音），所以靠后面的接缝压缩没听出问题；
    // 但「切口越过句段起点」本身是未定义行为：包络不可用时就会啃到字头，字边界与能量对齐时更是直接缺字。
    // 判据：扫描起点在切口内部、且**没有被整段覆盖**的第一个句段 → 切口终点收到它的起点。
    // 句内切口（起点落在某句中间，如分句悬空 / 句段内子切口）不受影响：宿主句段因起点更早被跳过。
    const clampCutEnd = ([a, b]) => {
      if (b - a < 0.05) return [a, b];
      for (const sg of rawSegs) {
        if (sg.s < a + 0.05) continue;           // 切口起点所在句段（句内切口）→ 不参与
        if (sg.s >= b - 0.001) break;            // 已经到切口之后
        if (sg.e <= b + 0.02) continue;          // 整段落在切口内 → 允许
        return [a, Math.max(a, sg.s)];           // 部分落在切口内 → 收到它的起点
      }
      return [a, b];
    };
    const snapCut = ([cs, ce]) => {
      let a = cs, b = ce;
      const inside = pauses.find(([ss, se]) => cs > ss && cs < se && !hasSpeechIn(ss, se));
      if (inside) a = inside[0];
      const next = pauses.find(([ss, se]) =>
        ss >= a - SNAP.insideToleranceSec && se > ce + SNAP.fineTailPadSec &&
        ss - ce <= SNAP.searchNextWithinSec &&
        !hasSpeechIn(ce, se));   // 中间夹着语音 → 不许吞
      if (next) b = Math.max(b, next[1] - SNAP.tailProtectSec);
      // 硬护栏：终点不得越过下一处语音的起点（留 nextSpeechPadSec 护住字头）。
      // 只夹「已经越界」的情况，不影响正常的吞静音行为。
      const nx = firstSpeechAfter(ce);
      const pad = SNAP.nextSpeechPadSec ?? 0.03;
      if (nx != null && b > nx) b = Math.max(ce, nx - pad);
      return [a, b];
    };
    // 吸附静音可能把两个原本相邻的候选取向同一个静音尾，产生重叠切口（拿去做减法虽不出错，
    // 但报告里会出现 [63.8-64.4] [64.0-64.4] 这种重叠区间，人工核对时很费解）→ 合并一次。
    // ⚠️ 顺序：clampCutEnd 必须在 snapCut **之前**。
    // snapCut 会把切口起点退回前置静音的开头（实测 C0777 #7：50.7 → 50.374），而 clampCutEnd
    // 靠「起点落在切口内部、且没被整段覆盖」找"下一句保留句"——回退之后，宿主句段本身
    // （#7 50.7–62.16）正好落入这个条件，5.12s 的段内多次起头切口被截成 [50.374,50.7]，
    // 只删掉了切口前的静音，前两遍废起头全留在成片里。snapCut 内部已有 firstSpeechAfter
    // 硬护栏，不会让终点越过下一处语音，所以先 clamp 是安全的。
    const cutsRaw = [...rt.cuts, ...st.cuts, ...mr.cuts, ...fl.cuts, ...f2.cuts, ...rs.cuts, ...qc.cuts, ...hf.cuts, ...osl.cuts].map(clampCutEnd).map(snapCut)
      .concat(rs.subCuts || [])
      .concat(qc.subCuts || [])   // 问句前缀卡壳：切口在字间，吸附会吞掉重来句的句头
      .concat(th.subCuts || [])   // 跨句尾首重说：切口在字间，吸附会吞掉后句的句头
      .concat(pr.subCuts || [])   // 段内前缀重说：切口同样落在字间（重来点前的停顿上）
      .concat(dc.subCuts || [])   // 分句悬空：切口落在字间，同样不做静音吸附（否则会吞掉补全句的句头）
      .sort((x, y) => x[0] - y[0]);
    const mergeCuts = (list) => {
      const out = [];
      for (const c of list.slice().sort((x, y) => x[0] - y[0])) {
        const l = out[out.length - 1];
        if (l && c[0] <= l[1] + (R.retake.mergeGapSec ?? 0.1)) l[1] = Math.max(l[1], c[1]);
        else out.push([...c]);
      }
      return out;
    };
    let cuts = mergeCuts(cutsRaw);
    // ── 短残句兜底 ──
    // 两头都被剪掉、自己又不与任何整句构成重说配对的小碎片（实测「之前有没有」0.78s），
    // 三层判据都看不见。判据见 retake.mjs detectShortResidues：≤10 字、左右都有切口、
    // 整句在后面第一条保留句里完整重现、且不是设问句。
    // 删掉后可能又露出新的这类碎片，所以跑两轮（第二轮一般只处理相邻残句）。
    if (process.env.XUNJIAN_RESIDUE !== "off") {
      for (let round = 0; round < 2; round++) {
        const res = detectShortResidues(rawSegs, cuts, R.retake.residue || {});
        if (!res.length) break;
        for (const x of res) {
          cuts.push([x.s, x.e]);
          report.push({ s: x.s, e: x.e, cut: x.text, kept: x.kept, reason: x.reason });
          console.log(`  ✂ ${x.reason}（${(x.e - x.s).toFixed(2)}s）`);
        }
        cuts = mergeCuts(cuts);
      }
    }
    cutsGlobal = cuts;
    // 低电平/底噪的整段切口在 2.6 已从 segs 扣除，这里补回清单供 cut-plan/审计复盘
    if (LOWLEVEL_CUTS.length) cutsGlobal = [...cutsGlobal, ...LOWLEVEL_CUTS].sort((x, y) => x[0] - y[0]);
    if (fl.report.length || f2.report.length || fl.cuts.length || f2.cuts.length)
      fs.writeFileSync(path.join(EP, "work/filler-report.json"),
        JSON.stringify({ tier1: { report: fl.report, cuts: fl.cuts }, tier2: { report: f2.report, cuts: f2.cuts } }, null, 1));
    if (cuts.length) {
      segs = subtractRanges(segs, cuts, R.retake.minRemainSec);
      segs = segs.filter(([s, e]) => e - s > R.segment.minKeptSec);   // 丢弃剪后残留的碎片段(它们正是幻觉字幕的来源)
      if (!segs.length) segs = [[0, rawDur]];
      const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;
      console.log(`  剪掉 ${report.length} 处冗余(重说/卡壳,保留后一遍,切口已吸附静音)——请核对,误剪就加 --no-retake 重跑:`);
      for (const r of report) console.log(`    ✂「${r.cut}」→ 保留「${r.kept}」${r.reason ? " · " + r.reason : ""}`);
      console.log(`    实际切口: ${cuts.map(([s, e]) => `[${fmt(s)}-${fmt(e)}]`).join(" ")}`);
      fs.writeFileSync(path.join(EP, "work/retake-report.json"), JSON.stringify({ report, cuts }, null, 1));
    } else console.log("  未发现重说段 ✓");
  } else console.log("  ⚠️ 转写不可用(需安装 uv),跳过重说检测");
}
// 剪完之后「新的首尾」可能又露出短碎片（原本被前一句挡着）→ 再过滤一次
{
  const r1 = dropEdgeFrags(segs);
  if (r1.dropped.length) {
    segs = r1.list;
    console.log(`  剪后首尾再清 ${r1.dropped.length} 处短碎片：` +
      r1.dropped.map(([s, e]) => `[${s.toFixed(2)}-${e.toFixed(2)}]`).join(" "));
  }
}
// ── 段尾回声：前一段的尾巴其实是下一句的起头（跨段假起头）──
// 实测 C0777：seg7 结尾「…题目也钻得进去**相反的一个脾气**。」（60.72–62.16），
// seg8 从「**相反的一个脾气**一点就着…」（64.38 起）重说。两段之间 2.22s 静音被丢弃，
// 成片里两遍直接焊成「相反的一个脾气 / 相反的一个脾气」。
// 现有判据（DUP_HEAD、假起头延伸、inner-retake）都在「段首↔段首」或「段内」，
// 管不到「前段段尾 ↔ 后段段首」；LLM 那边 #7 已判 slip，但它只给「整句 + keepId」，
// 执行层 slipPrefixCut 只会切头、切不了尾 —— 这一刀必须在这里补。
// 判据（全部满足才删）：① 前段末 k 字 == 后段首 k 字，k≥4；② 两段间隔 ≤3s（同一口气的自我打断）；
// ③ 缩尾后前段仍 ≥0.8s（否则整段删）；④ 被删时长 0.2~2.5s。
{
  const _nzT = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const charsOf = ([s, e]) => {
    const out = [];
    for (const sg of RAW_SEGS) {
      if (sg.e <= s - 0.02 || sg.s >= e + 0.02) continue;
      for (const [ws, we, word] of sg.w || []) {
        const clean = _nzT(word);
        if (!clean || ws < s - 0.02 || we > e + 0.02) continue;
        const n = clean.length, per = (we - ws) / n;
        let k = 0;
        for (const ch of clean) { out.push([ch, ws + per * k, ws + per * (k + 1)]); k++; }
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  };
  const TAILK = 4, TAILGAP = 3.0, TAILCUTMAX = 2.5, TAILMINLEFT = 0.8;
  // 护栏（2026-10-29 实测）：删完只剩几个字 → 成片里是个孤字硬拼，比不剪难听得多。
  const TAILMINHEAD = 4;
  // 护栏（2026-10-29 实测）：**同一 ASR 句内**的重复不是跨段假起头，是顶真/设问修辞。
  // 反例：「考阅读理解，阅读理解怎么去做啊？」—— 气口在中间 0.27s 停顿处切开，前段尾 4 字
  // 与后段首 4 字都是「阅读理解」，规则把前段的「阅读理解」整段删掉，成片变成
  // 「考 /（硬拼）/ 阅读理解怎么去做啊」：既丢了论题词，又多了个 0.25s 的孤字。
  // 真卡壳（C0777「…相反的一个脾气。」→「相反的一个脾气一点就着」）是**两句** ASR，
  // 间隔 2.22s，不会命中这条护栏。
  const inOneAsr = (t0, t1) => RAW_SEGS.some((sg) => sg.s <= t0 + 0.05 && sg.e >= t1 - 0.05);
  const hits = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const a = charsOf(segs[i]), b = charsOf(segs[i + 1]);
    if (a.length < TAILK || b.length < TAILK) continue;
    if (segs[i + 1][0] - segs[i][1] > TAILGAP) continue;
    let k = 0, ok = false;
    for (k = Math.min(8, a.length, b.length); k >= TAILK; k--) {
      if (a.slice(a.length - k).map((c) => c[0]).join("") === b.slice(0, k).map((c) => c[0]).join("")) { ok = true; break; }
    }
    if (!ok) continue;
    const cutAt = a[a.length - k][1];
    if (a.length - k < TAILMINHEAD) continue;
    if (inOneAsr(cutAt, segs[i + 1][0])) continue;
    const dur = segs[i][1] - cutAt;
    if (dur < 0.2 || dur > TAILCUTMAX) continue;
    hits.push({ i, k, cutAt, dur, tail: a.slice(a.length - k).map((c) => c[0]).join("") });
  }
  if (hits.length) {
    const gone = new Set(), addCuts = [];
    for (const h of hits) {
      const [s0, e0] = segs[h.i];
      if (h.cutAt - s0 < TAILMINLEFT) {
        gone.add(h.i); addCuts.push([s0, e0]);
        console.log(`  ✂ 段尾回声：整段删 [${s0.toFixed(2)}-${e0.toFixed(2)}]「…${h.tail}」（下一段从「${h.tail}」重说，本段只剩 ${(h.cutAt - s0).toFixed(2)}s 无内容）`);
      } else {
        segs[h.i] = [s0, h.cutAt]; addCuts.push([h.cutAt, e0]);
        console.log(`  ✂ 段尾回声：删前段尾部「${h.tail}」${h.dur.toFixed(2)}s（与下一段开头重合 ${h.k} 字）`);
      }
    }
    if (gone.size) segs = segs.filter((_, i) => !gone.has(i));
    cutsGlobal = [...cutsGlobal, ...addCuts].sort((x, y) => x[0] - y[0]);
  }
}
// ── 剪后中间孤立残句过滤 ──
// 前一句被判冗余删掉后，有时会剩下一个 3~4 字的孤立短段，前后都是长静音，
// 留在成片里上下文接不上（典型是上一句的尾巴）。
// 判据（全部满足才删）：非首尾段 / 段长 <0.8s / 文本 ≤6 字 / 与前段间隔 ≥1.0s / 与后段间隔 ≥1.5s。
// **设问短句例外**：「为什么/为啥/怎么回事/然后呢」本身就是独立短句，前后有停顿是正常的，
// 删了就变成"结论突然跳出来"，自问自答的逻辑断了（实测 C0777 1:33.5 的「为什么？」被这条规则删掉，
// 用户明确判定为"无关联漏剪"）。
{
  const ISO_MAX = 0.8, ISO_CHARS = 6, GAP_B = 1.0, GAP_A = 1.5;
  const KEEP_Q = /^(为什么|为啥|咋回事|怎么回事|怎么说|什么意思|然后呢|所以呢|对吧|是吧)/;
  const nrm = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const txtAt = ([s, e]) => {
    const inside = RAW_SEGS.find((t) => t.s >= s - 0.3 && t.e <= e + 0.3);
    const overlap = RAW_SEGS.filter((t) => t.s < e && t.e > s)
      .sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
    return nrm((inside || overlap || {}).z);
  };
  const iso = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const [s, e] = segs[i];
    if (e - s >= ISO_MAX) continue;
    if (s - segs[i - 1][1] < GAP_B || segs[i + 1][0] - e < GAP_A) continue;
    const txt = txtAt(segs[i]);
    if (!txt || txt.length > ISO_CHARS) continue;
    if (KEEP_Q.test(txt)) {
      // 设问例外要加一条**后件**条件：真正的自问自答，解释句是紧跟的（间隔通常 <1.5s，
      // 这种根本进不了本块 —— 上面的 GAP_A 已经放行了）。能走到这里的设问，后件至少隔 1.5s。
      // 实测 C0777：93.52 的「为什么？」后面隔 5.01s 才是「孩子的专注…」，而它的前句
      // （#11「孩子的专注，孩子的底气」）已被判 paraphrase 删掉 —— 前件没了、后件隔 5 秒，
      // 这不是自问自答，是录制被打断留下的孤句。故后件 >2.5s 不放行。
      const QFOLLOW = R.redundancy.keptQuestionFollowSec ?? 2.5;
      const nextGap = segs[i + 1][0] - e;
      if (nextGap <= QFOLLOW) {
        console.log(`  ↷ 保留孤立设问「${txt}」（下文 ${nextGap.toFixed(2)}s 内跟上，自问自答成立）`);
        continue;
      }
      console.log(`  ↷ 设问孤立「${txt}」：下文隔 ${nextGap.toFixed(2)}s，无自答，按半截话处理`);
    }
    iso.push({ seg: segs[i], txt });
  }
  if (iso.length) {
    const drop = new Set(iso.map((x) => x.seg));
    segs = segs.filter((sg) => !drop.has(sg));
    cutsGlobal = [...cutsGlobal, ...iso.map((x) => x.seg)].sort((a, b) => a[0] - b[0]);
    console.log(`  清理中间孤立残句 ${iso.length} 处（前后均长静音、字数极少，判为半截话）：`);
    for (const x of iso) console.log(`    ✂ [${x.seg[0].toFixed(2)}-${x.seg[1].toFixed(2)}]「${x.txt}」`);
  }
}
// ── 2.8b 剪后极短残块 ──
// 一段话被判整段删掉之后，剪口两侧常留下几十~几百毫秒的碎块。它不是"漏删的整句"，
// 也不是任何检测器能认领的对象（没有文本可判、比 minKeptSec 长一点所以没被 1752 行滤掉），
// 于是就这么留在成片里 —— 听感上是一声"咯噔"，比多留半句话更难受。
// 实测（5 工程全跑）：
//   · C0777 18.53–18.79「家庭里」、19.11–19.41「最该成」——「老是…那天」被删后剩下的两个字，
//     成片变成「是哪个哦 / 家庭里 / 最该成 / 我觉得一个家庭」，中间两声断音；
//   · C0820 8.35–8.63 0.28s —— 一点 ASR 都没识别出来的瞬态（低于 2.9 的 0.5s 门槛，漏网）。
// 两条判据（任一命中即删；都不命中就原样留着，不动正常短句）：
//   ① 区间内**没有任何** ASR 字，且 <noWordMaxSec → 噪声/换气残响；
//   ② 宿主句段已被删 ≥sentenceCutRatio，且本块 <crumbMaxSec → 那句话的碎渣。
// 「为什么？」这类设问短句的宿主句是整句保留的，覆盖率低，不会被误伤。
{
  const MINI = R.segment.crumbNoWordSec ?? 0.40;
  const CRUMB = R.segment.crumbMaxSec ?? 0.50;
  const HOST_RATIO = R.segment.crumbSentenceCutRatio ?? 0.7;
  const wordsIn = (s, e) => {
    for (const sg of RAW_SEGS) for (const [ws, we, w] of sg.w || [])
      if (we > s + 0.02 && ws < e - 0.02 && String(w).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "")) return true;
    return false;
  };
  const cutIn = (s, e) => cutsGlobal.reduce((a, [x, y]) => a + Math.max(0, Math.min(y, e) - Math.max(x, s)), 0);
  const crumbs = [];
  for (const [s, e] of segs) {
    const d = e - s;
    if (!wordsIn(s, e)) {
      if (d < MINI) crumbs.push({ s, e, why: "无字残响" });
      continue;
    }
    if (d >= CRUMB) continue;
    const host = RAW_SEGS.find((x) => x.s <= s + 0.06 && x.e >= e - 0.06)
      || RAW_SEGS.filter((x) => x.s < e && x.e > s).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
    if (!host || host.e - host.s < 0.4) continue;
    if (cutIn(host.s, host.e) / (host.e - host.s) >= HOST_RATIO) crumbs.push({ s, e, why: "句内碎渣" });
  }
  if (crumbs.length && crumbs.length < segs.length) {
    const drop = new Set(crumbs.map((x) => x.s));
    segs = segs.filter(([s]) => !drop.has(s));
    cutsGlobal = [...cutsGlobal, ...crumbs.map((x) => [x.s, x.e])].sort((a, b) => a[0] - b[0]);
    console.log(`  清理剪后极短残块 ${crumbs.length} 处：` +
      crumbs.map((x) => `[${x.s.toFixed(2)}-${x.e.toFixed(2)}]${x.why}`).join(" "));
  }
}
// ── 2.9 无转写噪声段：有能量、但 ASR 一个字都没识别出来 ──
// 起因（2026-10-29 实测）：01:37–01:39 有一处翻纸/碰麦噪声，silencedetect 完全看不到它 ——
//   该段 mean -31.2dB（同一素材人声段 -11.5dB），但 max 到 -13.4dB。
//   间歇峰值让「连续静音 ≥0.35s」永远不成立，于是它被当成语音段留在成片里，就是 1.5s 杂音。
// 判据（全部满足）：
//   ① 落在保留段内、且不在任何 ASR 逐字时间戳覆盖范围内（连语气词都没识别出来）；
//   ② 时长 ≥0.5s（更短的多是字间换气，删了反而把词咬断）；
//   ③ 平均电平 ≤ 噪声门-3dB（大部分时间其实在"静音"电平），且峰值 ≥ 噪声门+6dB（有瞬态）；
//   ④ 峰值比平均高 ≥10dB（宽带瞬态；稳态底噪不会有这种落差）；
//   ⑤ 时长 ≤8s（更长的多半是音乐/环境声，不自动处理）。
// 命中即删（与 tier1 语气词同一档自动动作），逐条进日志；XUNJIAN_NOISE_CUT=0 关闭。
{
  const AUTO = process.env.XUNJIAN_NOISE_CUT !== "0";
  if (AUTO && RAW_SEGS.length) {
    // ASR 覆盖表（逐字时间戳合并；没有 w 的 provider 退化成整句覆盖）
    const cov = [];
    for (const sg of RAW_SEGS) {
      const ws = Array.isArray(sg.w) && sg.w.length ? sg.w : [[sg.s, sg.e]];
      for (const w of ws) {
        const a = Number(w[0]), b = Number(w[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        const last = cov[cov.length - 1];
        if (last && a <= last[1] + 0.03) last[1] = Math.max(last[1], b);
        else cov.push([a, b]);
      }
    }
    cov.sort((x, y) => x[0] - y[0]);
    // 段内空洞
    const GAPMIN = R.noiseScan?.minSec ?? 0.5;
    const holes = [];
    for (const [S, E] of segs) {
      let cur = S;
      for (const [a, b] of cov) {
        if (b <= S + 0.02 || a >= E - 0.02) continue;
        if (a - cur >= GAPMIN) holes.push([Math.max(cur, S), Math.min(a, E)]);
        cur = Math.max(cur, b);
      }
      if (E - cur >= GAPMIN) holes.push([Math.max(cur, S), E]);
    }
    const probe = ([a, b]) => {
      const out = run(FFMPEG, ["-hide_banner", "-ss", a.toFixed(3), "-to", b.toFixed(3),
        "-i", input, "-vn", "-af", "volumedetect", "-f", "null", "-"]).stderr || "";
      return {
        mean: Number((/mean_volume:\s*(-?[\d.]+) dB/.exec(out) || [])[1]),
        max: Number((/max_volume:\s*(-?[\d.]+) dB/.exec(out) || [])[1]),
      };
    };
    const MAXSCAN = R.noiseScan?.maxScan ?? 40;
    const hits = [];
    for (const h of holes.slice(0, MAXSCAN)) {
      const d = h[1] - h[0];
      if (d > (R.noiseScan?.maxSec ?? 8)) continue;
      const { mean, max } = probe(h);
      if (!Number.isFinite(mean) || !Number.isFinite(max)) continue;
      if (mean > NOISE - 3) continue;
      if (max < NOISE + 6) continue;
      if (max - mean < 10) continue;
      hits.push({ s: h[0], e: h[1], mean, max });
    }
    if (hits.length) {
      // 两端各留 30ms：ASR 词边界本身有 ±20ms 误差，贴边切会咬到相邻字
      const picked = hits
        .map((h) => ({ ...h, a: +(h.s + 0.03).toFixed(3), b: +(h.e - 0.03).toFixed(3) }))
        .filter((h) => h.b - h.a >= 0.3);
      if (picked.length) {
        const cuts = picked.map((h) => [h.a, h.b]);
        segs = applyDecisions(segs, [{ choice: "cut", cuts }]);
        cutsGlobal = [...cutsGlobal, ...cuts].sort((a, b) => a[0] - b[0]);
        console.log(`  ✂ 无字噪声段 ${cuts.length} 处（有能量但 ASR 无字，判为翻纸/碰麦/桌面噪声）：`);
        for (const h of picked) {
          console.log(`    [${h.a.toFixed(2)}-${h.b.toFixed(2)}] ${(h.b - h.a).toFixed(2)}s` +
            ` · mean ${h.mean.toFixed(1)}dB / max ${h.max.toFixed(1)}dB（噪声门 ${NOISE}dB）`);
        }
      }
    }
  }
}
// ── 2.9b 剪后残留审计：把「没有任何通道认领」的漏剪摆到待确认里 ──
// 前面所有检测器都是"找得到才动手"。找不到的不会报错、不会进日志 —— 成片里安安静静留着
// 半截话，事后和"本来就没问题"分不出来。这里是最后一道只读扫描：结构证据命中但最终
// 仍完整保留的单元，一律进待确认（默认保留，不改变任何已有剪辑结果）。
{
  const ON = process.env.XUNJIAN_RESIDUAL_AUDIT !== "off" && RAW_SEGS.length > 0;
  if (ON) {
    const units = SPLIT_UNITS.length ? SPLIT_UNITS : RAW_SEGS.map((x, i) => ({ ...x, srcId: i, part: 0 }));
    const hits = auditResiduals(units, segs, R.redundancy?.residual || {});
    let n = 0;
    for (const h of hits) {
      const [a, b] = h.cutRange || [];
      if (!(b - a >= 0.15)) continue;
      // 这一刀已经落在已剪区间里 → 无需提醒
      if (!segs.some(([s, e]) => Math.min(e, b) - Math.max(s, a) > 0.1)) continue;
      pushReview({
        kind: h.kind, priority: h.priority ?? 2, s: a, e: b, segId: -1,
        text: h.text, line: h.why,
        guard: { rule: h.kind, value: h.why, limit: "剪后残留审计：结构证据仍在成片里" },
        question: `${h.why}。删掉还是保留？`,
        options: [{ label: "删除", cuts: [[a, b]] }, { label: "保留", cuts: [] }],
      });
      n++;
    }
    AUDIT_STATS = { scanned: units.length, hits: hits.length, queued: n };
    if (n) console.log(`  ? 剪后残留审计：${n} 处疑似漏剪已进待确认（kind: ${[...new Set(hits.map((h) => h.kind))].join("/")}）`);
  }
}
// ── 2.95 收紧气口（可选：剪辑台「收紧气口」按钮 / --tight-breath）──
// 前面的 silencedetect 只能剪「连续 ≥0.35s 低于噪声门」的静音，而 keepGapSec=0.2 又会把
// 剪完只剩 0.2s 的缝整段保留 —— 句间那些 0.2~0.35s 的换气就是这么漏下来的。
// 这一层不依赖 silencedetect：逐帧能量掩膜，把保留段内所有低于「语音参考-18dB」的帧剪掉，
// 段边界同时内缩 guard（默认 60ms，覆盖 40ms 交叉淡化 + 帧网格吸附余量，让淡化落在静音一侧）。
// 再加一道字级护卫：ASR 逐字时间戳里「这个字自己在出声」（自身峰值-10dB 以上）的帧不许剪，
// 否则比全片 p90 低 20dB 以上的鼻音/轻辅音音节（嗯/么/词尾）会被当成气口切碎。
// 放在最末：此时重说/卡壳/语气词/冗余/噪声的切口都已落定，只需要处理"最后剩下的波形"。
// ASR 逐字时间戳：收紧气口的字级护卫、半字收口都要用（只判「这个字在不在出声」，不当切口边界）
const WORD_SPANS = [];
for (const sg of RAW_SEGS) for (const [a, b, c] of sg.w || []) WORD_SPANS.push({ s: +a, e: +b, c });
let TIGHT_INFO = null;
if (TIGHT) {
  step("收紧气口（逐帧能量掩膜）");
  const tb = path.join(EP, "work/_tight.pcm");
  const t = tightenFile({ ffmpeg: FFMPEG, input, segs, tmpPcm: tb, words: WORD_SPANS, opt: R.tightBreath });
  TIGHT_INFO = t.stats;
  if (!t.stats.applied) {
    console.log(`  ⚠️ 本次未收紧：${t.stats.reason}`);
  } else {
    console.log(`  语音参考 ${t.stats.refDb}dB → 掩膜门限 ${t.stats.thresholdDb}dB · 边界内缩 ${t.stats.guardSec}s · 最短可剪 ${t.stats.minRunSec}s`);
    if (t.stats.wordProtectedSec) console.log(`  字级护卫：${t.stats.wordProtectedSec}s 弱音节被判为有声，已排除在可剪区外（字峰值-${t.stats.wordGuardDb}dB）`);
    console.log(`  保留 ${t.stats.beforeSec}s → ${t.stats.afterSec}s：剪掉 ${t.stats.savedSec}s 气口` +
      `（段内 ${t.stats.innerCutSec}s + 段首尾 ${t.stats.edgeTrimSec}s，${t.stats.cuts} 刀，${t.stats.segsBefore}→${t.stats.segsAfter} 段）`);
    segs = t.segs;
    cutsGlobal = [...cutsGlobal, ...t.cuts].sort((a, b) => a[0] - b[0]);
    try {
      fs.writeFileSync(path.join(EP, "work/tight-breath.json"), JSON.stringify(t.stats, null, 1));
    } catch {}
  }
}
// ── 3. 剪切 + 提速 + 转码（编辑器友好的密集关键帧）──
step(Math.abs(SPEED - 1) < 1e-9 ? "剪切并转码（1.0x，不提速）" : `剪切并提速 ${SPEED}x`);
fs.mkdirSync(path.join(EP, "work"), { recursive: true });
fs.mkdirSync(path.join(EP, "hf/assets"), { recursive: true });
// 边界淡化:atrim 是硬切,拼接处波形直接从有声跳到有声/无声,产生突跳(click)。
// 成片转写会把这种突跳"听"成辅音,进而幻觉出一个不存在的词(实测边界处产出幻觉字幕「保护」)。
// 对每段的音频两端加极短淡入淡出即可消除突跳;淡化落在被剪掉的静音一侧,不削弱正常字音。
// 默认值见 rules.json segment.edgeFadeSec,可用 XUNJIAN_EDGE_FADE 覆盖(设 0 关闭)。
const FADE = Math.max(0, Number(process.env.XUNJIAN_EDGE_FADE ?? R.segment.edgeFadeSec));
// 单链 select 版滤镜图：N 段不再展开成 N 条 trim 分支（那些分支会把 commit 内存吃到 GB 级，
// 见 cutfilters.mjs 顶部的事故记录）。边界淡化由 buildCutFilter 用 V 形 volume 还原。
//
// ── 接缝静音压缩 + 帧网格吸附（顺序是硬约束）─────────────────────
// 「切口过松、有留白」不是切点算错，而是**删除只覆盖文字**：删除区间两侧的静音留在保留段里
// 原封不动地对拼。实测 103s 素材 26 个拼接点，接缝静音中位 0.39s、23 个 >0.25s，
// 合计 11.27s = 成片 12.6%。这里把每个拼接点两侧的静音各裁到 seamGapSec/2，
// 留一点点呼吸，其余剪掉；同时把能量包络交给 buildCutFilter，淡化时长按实际余量逐点自适应。
//
// 与「收紧气口」的关系（两者叠在一起时别把顺序写反）：
//   · tight-breath 是 squeeze 的**超集** —— 它把段内低能量帧全剪了，段边界还内缩了 guardSec。
//     所以 TIGHT 生效时**跳过 squeeze**：再压一次只会把 tight 特意留给淡化的 guard 啃掉，
//     而 tight 自己那 60ms 已经比 seamGap 的 60ms 半宽更保守，压不出任何收益。
//   · snap 必须放在最后：tight 的 guardSec 注释里写明「覆盖 40ms 淡化 + 帧网格吸附余量」，
//     先 snap 再 tight 会把余量吃两遍。
let ENV = null;
{
  const wav = path.join(EP, "work/raw-asr.wav");
  if (fs.existsSync(wav)) {
    try {
      ENV = envelopeFor(EP, wav, FFMPEG);
      if (TIGHT_INFO && TIGHT_INFO.applied) {
        // 收紧模式下不压接缝，只借 ENV 逐点算淡化时长
      } else {
        const seamGap = Number(R.segment.seamGapSec ?? 0.12);
        const sq = squeezeSeams(ENV, segs, { keepGap: seamGap, minKept: R.segment.minKeptSec });
        const d0 = segs.reduce((a, [s, e]) => a + e - s, 0);
        const d1 = sq.reduce((a, [s, e]) => a + e - s, 0);
        segs = sq;
        if (d0 - d1 > 0.02) console.log(`  接缝静音压缩 ${(d0 - d1).toFixed(2)}s（气口留 ${Math.round(seamGap * 1000)}ms）`);
      }
    } catch (e) { console.log(`  ⚠️ 包络不可用，跳过接缝压缩: ${e.message}`); }
  }
}
// 半字收口：只处理「语音已经被削掉一半以上」的字，把剩下的那点语音一起剪掉。
// 判据看语音窗口不看 token 中点（ASR 把字尾停顿算进字里），见 cutfilters.trimCutsToVoice。
{
  const sw = trimCutsToVoice(segs, WORD_SPANS, ENV);
  if (sw.fixed.length) {
    const d0 = segs.reduce((a, [s, e]) => a + e - s, 0);
    const d1 = sw.segs.reduce((a, [s, e]) => a + e - s, 0);
    segs = sw.segs;
    console.log(`  半字收口 ${sw.fixed.length} 处（多剪 ${(d0 - d1).toFixed(2)}s）：` +
      sw.fixed.slice(0, 8).map((f) => `${f.text}@${f.at}s(+${f.wound.toFixed(2)})`).join(" ") + (sw.fixed.length > 8 ? " …" : ""));
  }
}
// 落盘前先把段边界吸附到「帧中点」：滤镜按吸附后的边界剪，计划里也存吸附后的值 ——
// 这样 /api/timeline 的时长、审核区间、重导出用的都是同一套时间，不会各算一套差个零点几秒。
if (FPS > 0) {
  const snapped = snapSegs(segs, FPS);
  if (snapped.length && (snapped.length !== segs.length || snapped.some((x, i) => Math.abs(x[0] - segs[i][0]) > 1e-4 || Math.abs(x[1] - segs[i][1]) > 1e-4))) {
    const d0 = segs.reduce((a, [s, e]) => a + e - s, 0), d1 = snapped.reduce((a, [s, e]) => a + e - s, 0);
    segs = snapped;
    console.log(`  段边界吸附到 ${FPS}fps 帧网格（${segs.length} 段 · ${d0.toFixed(2)}→${d1.toFixed(2)}s，避免多段拼接后音视频累计错位）`);
  } else if (snapped.length) {
    segs = snapped;
  }
}
const fc = buildCutFilter(segs, { speed: SPEED, fade: FADE, fps: FPS, env: ENV });
if (FADE > 0) console.log(`  剪切边界淡化 ${(FADE * 1000).toFixed(0)}ms(消除拼接突跳与幻觉字幕)`);
// 审核队列落盘：剪辑台读这个文件生成「时间轴标记 + 提问卡」，用户改的决定写进 overrides.json，
// 再由 firstcut/reexport.mjs 按区间重剪 —— 全程不回模型，结论不会漂。
// 先与**最终保留段**求交：落在气口已剪区间里的条目点了「删除」也没有效果，必须剔除。
const _rq = clipReviewItems(REVIEW, segs);
fs.writeFileSync(path.join(EP, "work/review-queue.json"), JSON.stringify(
  { name: NAME, rawDur: +rawDur.toFixed(3), items: _rq.items }, null, 1));
if (_rq.items.length || _rq.dropped || _rq.alreadyRemoved)
  console.log(`  ? 待你确认 ${_rq.items.length} 条`
    + `${_rq.alreadyRemoved ? `（其中 ${_rq.alreadyRemoved} 条区间已被气口/低电平整句删掉，标为只读提示）` : ""}`
    + `${_rq.dropped ? `（另有 ${_rq.dropped} 条已剔除）` : ""} → work/review-queue.json`);
// 覆盖报告：每个语义单元最终是「整段删 / 部分删 / 保留 / 有卡片」。
// 验收时按这张表逐条核对"有没有漏"，不必再去成片里找。
if (RAW_SEGS.length) {
  const units = SPLIT_UNITS.length ? SPLIT_UNITS : RAW_SEGS.map((x, i) => ({ ...x, srcId: i, part: 0 }));
  const cov = coverageReport(units, segs, cutsGlobal, _rq.items);
  fs.writeFileSync(path.join(EP, "work/cut-audit.json"), JSON.stringify({
    name: NAME,
    base: RAW_SEGS.length, units: units.length, marks: SPLIT_MARKS,
    audit: AUDIT_STATS,
    summary: {
      deleted: cov.filter((x) => x.status === "deleted").length,
      partial: cov.filter((x) => x.status === "partial").length,
      kept: cov.filter((x) => x.status === "kept").length,
      withCard: cov.filter((x) => x.card).length,
    },
    units: cov,
  }, null, 1));
}
// 落盘剪切计划:保留段/切口/提速/淡化,供离线复算"输出时间 ↔ 原片时间"映射,
// 用来定位成片转写里的幻觉字幕落在哪个拼接边界上(边界幻觉回归验证脚本读这个文件)。
// input/name 供 reexport.mjs 从计划直接重剪，不必重跑转写。
// `removed` = segs 的补集（成片里**全部**被拿掉的区间，含气口/静音）。
// 为什么不能只给 cuts：cuts 只记「检测器判定的错话切口」，气口是另一条链路剪的，
// 两边不是互补关系。验收时只看 cuts 会把「3.07s 被删了却没记录」误判成静默漏删，
// 反过来只看 segs 又分不清那 3s 是"删了错话"还是"删了停顿"。两个都给才核对得动。
const REMOVED = (() => {
  const out = [];
  let cur = 0;
  for (const [s, e] of segs.slice().sort((a, b) => a[0] - b[0])) { if (s > cur + 0.005) out.push([+cur.toFixed(3), +s.toFixed(3)]); cur = Math.max(cur, e); }
  if (cur < rawDur - 0.005) out.push([+cur.toFixed(3), +rawDur.toFixed(3)]);
  return out;
})();
fs.writeFileSync(path.join(EP, "work/cut-plan.json"), JSON.stringify(
  { name: NAME, input: path.resolve(input), rawDur: +rawDur.toFixed(3), speed: SPEED, fade: FADE, fps: FPS, noise: NOISE, segs, cuts: cutsGlobal, removed: REMOVED, tight: TIGHT_INFO, speech: SPEECH_INFO, askChain: ASKCHAIN_INFO, metaTalk: METATALK_INFO }, null, 1));
const fcPath = path.join(EP, "work/cutfc.txt");
fs.writeFileSync(fcPath, fc);
const camName = "cam-" + NAME + ".mp4";
const cam = path.join(EP, "hf/assets", camName);
// 先写 .part.mp4，成片探测通过才原子改名 —— 与 reexport.mjs 同一套。
// 为什么首剪也要：ffmpeg 中途失败时留下的半截文件用的是正式名字，
// 下一次重跑 -y 会把它截断重写，结果「版本档里记着 140s、磁盘上只有 22s」。
const camPart = cam.replace(/\.mp4$/i, ".part.mp4");
try { fs.unlinkSync(camPart); } catch {}
const cutArgs = (fcArgs) => ["-y", "-v", "error", "-i", input, ...fcArgs,
  "-map", "[vf]", "-map", "[af]", "-c:v", "libx264", "-crf", `${R.encode.crf}`, "-preset", `${R.encode.preset}`,
  "-pix_fmt", "yuv420p", "-g", `${R.encode.gopFrames}`, "-c:a", "aac", "-b:a", `${R.encode.audioBitrate}`, camPart];
let r = run(FFMPEG, cutArgs(["-filter_complex_script", fcPath]));
if (r.status !== 0 && /Unrecognized option 'filter_complex_script'/.test(r.stderr || "")) {
  // ffmpeg 7.0 起废弃该选项,部分新构建(如 Windows choco 版)已移除 → 滤镜图改内联直传
  r = run(FFMPEG, cutArgs(["-filter_complex", fc.replace(/\n/g, "")]));
}
if (r.status !== 0) {
  try { fs.unlinkSync(camPart); } catch {}
  die("剪切失败: " + r.stderr?.slice(-300));
}

step("响度归一 (loudnorm 单独一步)");
const voice = path.join(EP, "work/voice-norm.wav");
r = run(FFMPEG, ["-y", "-v", "error", "-i", camPart, "-vn", "-af", `loudnorm=${R.encode.loudnorm}`, "-ar", "48000", voice]);
if (r.status !== 0) die("loudnorm 失败");
const dur = Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", camPart]).stdout.trim());
if (!Number.isFinite(dur) || dur <= 0) { try { fs.unlinkSync(camPart); } catch {} die("成片时长探测失败，疑似合片被中断"); }
try { fs.unlinkSync(cam); } catch {}
fs.renameSync(camPart, cam);   // 从这一刻起才对本机版本扫描可见
console.log(`  成片素材 ${dur.toFixed(1)}s → ${path.relative(ROOT, cam)}`);

// ── 版本链登记 ──
// 首剪记 v1；「收紧气口」重跑由服务端先冻结旧版（cam-x.mp4 → cam-x.vN.mp4），
// 再传 XUNJIAN_REBASE_TO=<新版本号>，这里按那个号登记，绝不覆盖 v1。
try {
  const vp = path.join(EP, "work/versions.json");
  let vs = { name: NAME, current: 1, items: [] };
  if (fs.existsSync(vp)) {
    try {
      const j = JSON.parse(fs.readFileSync(vp, "utf8"));
      if (Array.isArray(j.items)) vs = { name: NAME, current: j.current || 1, items: j.items };
    } catch {}
  }
  const wantV = REBASE_TO > 0 ? REBASE_TO : 1;
  const isRebase = REBASE_TO > 0;
  const rec = { v: wantV, file: `hf/assets/${camName}`, kind: isRebase ? "rebase" : "cut",
    at: new Date().toISOString(),
    dur: +dur.toFixed(3), segs: segs.length, decisions: 0, cuts: cutsGlobal.length,
    note: isRebase
      ? `重跑 v${wantV}（${segs.length} 段${TIGHT_INFO && TIGHT_INFO.applied ? ` · 收紧气口 -${TIGHT_INFO.savedSec}s` : ""}）`
      : `首剪（${segs.length} 段 · 规则裁决${TIGHT_INFO && TIGHT_INFO.applied ? ` · 收紧气口 -${TIGHT_INFO.savedSec}s` : ""}）` };
  if (isRebase) {
    vs.items = (vs.items || []).filter((x) => Number(x.v) !== wantV);   // 同号先清掉，避免重复条目
    vs.items.push(rec);
  } else {
    const at = vs.items.findIndex((x) => Number(x.v) === 1);
    if (at >= 0) vs.items[at] = { ...vs.items[at], ...rec };   // 重跑首剪会覆盖 v1，记录跟着更新
    else vs.items.push(rec);
  }
  vs.items.sort((a, b) => a.v - b.v);
  vs.current = wantV;                             // 刚剪完，最新版就是这一版
  fs.writeFileSync(vp, JSON.stringify(vs, null, 1));
} catch (e) {
  console.warn(`  ⚠️ 版本档写入失败（不影响成片）：${e.message}`);
}

// ── --cut-only：剪辑层到此为止 ──
if (CUT_ONLY) {
  const kept = segs.reduce((a, [s, e]) => a + e - s, 0);
  const u = finishUsage(USAGE);
  console.log(`\n✅ 剪辑层完成（--cut-only）`);
  console.log(`   原片 ${rawDur.toFixed(1)}s → 成片 ${dur.toFixed(1)}s（保留 ${segs.length} 段，${(dur / rawDur * 100).toFixed(0)}%），提速 ${SPEED}x`);
  if (u) console.log(`   本轮花费 ¥${u.total.toFixed(4)}（模型 ¥${u.llmCost.toFixed(4)} · 转写 ¥${u.asrCost.toFixed(4)}）`);
  console.log(`   成片: ${path.relative(ROOT, cam)}`);
  console.log(`   剪点清单: ${path.relative(ROOT, path.join(EP, "work/retake-report.json"))} · 剪切计划: work/cut-plan.json`);
  process.exit(0);
}

// ── 4. 转写字幕（uv + faster-whisper，缺环境则跳过）──
step("转写逐字字幕");
const capsPath = path.join(EP, "work/caps-full.json");
const asrIn = path.join(EP, "work/asr-in.wav");
run(FFMPEG, ["-y", "-v", "error", "-i", voice, "-ac", "1", "-ar", "16000", asrIn]);
// v4：成片字幕改为**关热词**转写 + 分块 + 覆盖缺口检测（asr_and_caps.py 内建）。
// 原用热词(initial_prompt)提术语准确率，但实测会触发 whisper 整段跳读、丢大段语音；
// 术语错字改由 caption.fixes 词典 + LLM 同音纠错兜底。
// cloud：一次云端转写拿 IR，再用 asr_and_caps.py 的 replay 入口在本地断行（不二次计费）。
const capsSegsPath = path.join(EP, "work/caps-segs.json");
const asr = transcribeCaps(asrIn, capsPath, capsSegsPath);
noteAsr(USAGE, asr.stdout);
let caps = [];
if (asr.status === 0 && fs.existsSync(capsPath)) {
  caps = JSON.parse(fs.readFileSync(capsPath, "utf8"));
  console.log("  " + (asr.stdout.trim().split("\n").pop() || `${caps.length} 行字幕`));
} else {
  fs.writeFileSync(capsPath, "[]");
  console.log(`  ⚠️ 成片转写失败: ${asrFail(asr)}`);
  console.log("     （需 uv: https://docs.astral.sh/uv/ ；模型下载受阻时设 HF_ENDPOINT=https://hf-mirror.com）");
}

// ── 4.4 错字纠错(①):LLM 同音纠错,只纠别字、严禁改写(默认关闭,先 A/B 验证)──
if (!NO_AI && (R.corrections.enabled || process.env.XUNJIAN_CORRECTIONS === "1") && arbiterOk("asr-fix") && caps.length) {
  step(`错字纠错（${LLM_MODEL}）`);
  const glossary = [];
  try {
    const hw = fs.readFileSync(path.join(ROOT, "firstcut/hotwords.txt"), "utf8")
      .split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    glossary.push(...hw);
  } catch { /* 无热词文件则忽略 */ }
  glossary.push(...((R.caption && R.caption.userDict) || []));
  // 分批送 LLM:整片一次送会让小模型趋于保守(实测几乎不改),每批 ~6 行产出明显更好
  const CH = R.corrections.chunkSize ?? 6;
  const allLines = caps.map((c, i) => ({ id: i, text: c.z }));
  const fixList = [];
  for (let k = 0; k < allLines.length; k += CH) {
    const vv = adjudicate("asrfix", { glossary: [...new Set(glossary)], lines: allLines.slice(k, k + CH) });
    if (vv && Array.isArray(vv.fixes)) fixList.push(...vv.fixes);
    else console.log(`  ⚠️ 纠错第 ${k / CH + 1} 批不可用，跳过`);
  }
  const v = { fixes: fixList };
  if (v && Array.isArray(v.fixes)) {
    let rejected = 0;
    const cand = [];
    for (const fx of v.fixes) {
      const i = fx && Number.isInteger(fx.id) ? fx.id : -1;
      if (i < 0 || i >= caps.length || typeof fx.text !== "string") { rejected++; continue; }
      const orig = caps[i].z, fixed = fx.text.trim();
      if (!fixed || fixed === orig) continue;
      if (Math.abs(fixed.length - orig.length) > 2) { rejected++; continue; }               // 长度突变 → 疑似改写
      if (lev(fixed, orig) > (R.corrections.maxEditPerLine ?? 8)) { rejected++; continue; }  // 改动过大 → 疑似改写
      cand.push({ id: i, from: orig, to: fixed, reason: fx.reason || "" });
    }
    // 拼音护栏:只接受"改动区读音相近"的修改(同音/近音替换),防 LLM 改写或幻觉
    let sims = null;
    if (cand.length) {
      const fi = path.join(EP, "work/_fix_in.json"), fo = path.join(EP, "work/_fix_out.json");
      fs.writeFileSync(fi, JSON.stringify(cand.map((r) => [r.from, r.to])));
      const chk = run(UV, ["run", "--with", "pypinyin", "python", path.join(ROOT, "firstcut/pinyin_check.py"), fi, fo], { env: ASR_ENV });
      if (chk.status === 0 && fs.existsSync(fo)) { try { sims = JSON.parse(fs.readFileSync(fo, "utf8")); } catch { /* 解析失败按不可用处理 */ } }
      if (!sims) console.log(`  ⚠️ 拼音校验不可用，本次纠错全部丢弃(保守): ${asrFail(chk)}`);
    }
    const MINSPAN = R.corrections.pinyinSimMin ?? 0.5;
    let applied = 0;
    const reps = [];
    for (let k = 0; k < cand.length; k++) {
      if (sims && !(sims[k] && sims[k].span >= MINSPAN)) { rejected++; continue; }
      const r = cand[k];
      reps.push(r); caps[r.id].z = r.to; applied++;
    }
    fs.writeFileSync(path.join(EP, "work/asr-fixes.json"), JSON.stringify({ applied, rejected, report: reps }, null, 1));
    console.log(`  纠错 ${applied} 行${rejected ? `，丢弃 ${rejected} 处疑似改写/不可信` : ""}（详见 work/asr-fixes.json）`);
    if (applied) fs.writeFileSync(capsPath, JSON.stringify(caps, null, 1));
  } else console.log("  ⚠️ 错字纠错不可用，保留原字幕");
}

// ── 4.5 字幕断行裁决（已弃用：改用 asr_and_caps.py 的 phraseAware DP，见 rules.caption）──
// 机械断行会产生 1~2 字碎行、或把词切开;分组重组能同时修这两类问题(逐行对切一刀做不到"合并")。
// 硬约束:只在组内重新划线、不增删字;输出拼接后必须等于原文,否则该组回退原样(防 LLM 改写)。
// 关闭方式:--no-ai 或 rules.arbiter.enabled=false;裁决明细落 work/break-verdicts.json。
if (!NO_AI && R.arbiter.enabled && (R.arbiter.kinds || []).includes("caption-break") && caps.length >= 2) {
  step(`字幕断行裁决（${LLM_MODEL}）`);
  const GROUP = R.arbiter.groupSize || 6;
  const MAXC = R.caption.maxCharsPerLine;
  const allG = [];
  for (let g = 0; g < caps.length; g += GROUP) allG.push({ id: g, seg: caps.slice(g, g + GROUP) });
  const send = allG.filter((x) => x.seg.length >= 2)
    .map((x) => ({ id: x.id, lines: x.seg.map((c) => c.z), text: x.seg.map((c) => c.z).join("") }));
  if (!send.length) console.log("  无可裁决的字幕组");
  else {
    const ap = fs.readFileSync(path.join(ROOT, "firstcut/arbiter-prompt.md"), "utf8")
      .replaceAll("{{MAX}}", String(MAXC))
      .replaceAll("{{GROUPS}}", JSON.stringify(send));
    const ax = llmText(ap, "caption-break", LLM_MODEL);
    const ao = ax.stdout || "";
    let judged = [];
    try { judged = (JSON.parse(ao.slice(ao.indexOf("{"), ao.lastIndexOf("}") + 1)).groups) || []; }
    catch { console.log(`  ⚠️ 裁决输出解析失败，保留原断行: ${(ao || "").trim().slice(0, 120)}`); }
    const byId = new Map(judged.map((x) => [x.id, x]));
    const out = [];
    let moved = 0, rej = 0;
    const report = [];
    for (const g of allG) {
      const orig = g.seg.map((c) => c.z);
      let parts = orig;
      const res = byId.get(g.id);
      if (res && Array.isArray(res.cuts) && res.cuts.length) {
        const txt = orig.join("");
        // 容错:过滤越界/非整数切点(实测 LLM 常把末尾 len 也塞进来)
        const cuts = [...new Set(res.cuts.filter((c) => Number.isInteger(c) && c > 0 && c < txt.length))]
          .sort((a, b) => a - b);
        const tooLong = cuts.some((c, i) => c - (i ? cuts[i - 1] : 0) > MAXC)
          || (txt.length - (cuts[cuts.length - 1] || 0)) > MAXC;
        if (!cuts.length || tooLong) rej++;
        else {
          const p = []; let pv = 0;
          for (const c of cuts) { p.push(txt.slice(pv, c)); pv = c; }
          p.push(txt.slice(pv));
          if (p.join("") === txt) {                 // 防改写:字符必须守恒
            if (p.join("|") !== orig.join("|")) { moved++; report.push({ id: g.id, from: orig, to: p, reason: res.reason || "" }); }
            parts = p;
          } else rej++;
        }
      }
      if (parts === orig) {                         // 未改动:时间原样保留
        g.seg.forEach((c) => out.push({ s: c.s, e: c.e, z: c.z }));
      } else {                                      // 改动:组内时间按字符比例重新分配
        const s0 = g.seg[0].s, e1 = g.seg[g.seg.length - 1].e;
        const tot = parts.join("").length || 1;
        let acc = s0;
        parts.forEach((t, i) => {
          const e = i === parts.length - 1 ? e1 : +(acc + (e1 - s0) * (t.length / tot)).toFixed(3);
          out.push({ s: +acc.toFixed(3), e: +e.toFixed(3), z: t });
          acc = e;
        });
      }
    }
    fs.writeFileSync(path.join(EP, "work/break-verdicts.json"),
      JSON.stringify({ groups: send.length, moved, rejected: rej, report }, null, 1));
    if (moved > 0) { caps = out; fs.writeFileSync(capsPath, JSON.stringify(caps, null, 1)); }
    console.log(`  裁决 ${send.length} 组 → 重组 ${moved} 组${rej ? `，丢弃 ${rej} 组非法输出` : ""}（详见 work/break-verdicts.json）`);
  }
}

// ── 5. 渲染器与依赖就位 ──
// 这两份属于「程序自带模板」：正常安装/仓库里都有，但漏打就要人命 —— 原来这里是裸
// copyFileSync，缺文件直接 ENOENT 崩掉整条流水线（2026-11-10 核对安装包时发现 1.1.4/1.1.5
// 都漏了）。改成缺了就跳过并提示：表达式渲染器用不了，但初剪本身不该挂。
//
// 位置：安装包放 runtime/renderer —— 不能放 episodes/demo，否则程序目录里出现 episodes/，
// firstcut/home.mjs 的「有 episodes 就是源码/老布局」判据会把安装目录当成数据目录，
// 工程数据写进 Program Files 下，卸载时连数据一起没。源码仓库仍是老位置。
const RENDER_DIRS = ["runtime/renderer", "episodes/demo"];
const findTpl = (rel) => {
  for (const d of RENDER_DIRS) {
    const p = path.join(ROOT, d, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
};
for (const rel of ["gen.js", "package.json"]) {
  const from = findTpl(rel);
  if (!from) { console.log(`  ⚠️ 缺少渲染器模板 ${rel}，跳过（程序目录不完整？）`); continue; }
  fs.copyFileSync(from, path.join(EP, path.basename(rel)));
}
const gsap = findTpl("hf/assets/gsap.min.js");
if (gsap) fs.copyFileSync(gsap, path.join(EP, "hf/assets/gsap.min.js"));

// ── 6. timeline：AI 初剪 或 骨架 ──
const DEFAULT_BOXES = { cam: { y: 0, h: 1920 }, chap: { y: 100 }, title: { y: 170 }, beat: { x: 76, y: 1020, w: 860 }, cap: { y: 1400 }, card: { x: 56, y: 260, w: 968, h: 470 } };
// 版式模板同理：读不到就退回内置值，不给一条初剪判死刑
const boxes = (() => {
  const p = path.join(ROOT, "assets/timeline-template.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")).boxes || DEFAULT_BOXES; }
  catch (e) { console.log(`  ⚠️ 版式模板读不到（${e.code || e.message}），用内置默认版式`); return DEFAULT_BOXES; }
})();
const skeleton = () => ({
  meta: { episode: NAME, name: NAME, layout: "V0-fx", title: "待定|标题|", dur: +dur.toFixed(2), durPreview: +dur.toFixed(2), cam: { full: camName, preview: camName }, capsFile: "work/caps-full.json" },
  boxes, chapters: [{ n: "01", lab: "全片", en: "ROUGH CUT", s: 0, e: +dur.toFixed(2) }], pops: [], cards: [], media: [], chipT: null,
});
let timeline = skeleton();
if (!NO_AI && !NO_AICUT && caps.length) {
  step(`AI 初剪（调用 ${LLM_MODEL}，约 1-2 分钟）`);
  const prompt = fs.readFileSync(path.join(ROOT, "firstcut/ai-cut-prompt.md"), "utf8")
    .replaceAll("{{DUR}}", dur.toFixed(2)).replaceAll("{{EPISODE}}", NAME).replaceAll("{{CAM}}", camName)
    .replaceAll("{{BOXES}}", JSON.stringify(boxes)).replaceAll("{{CAPTIONS}}", JSON.stringify(caps));
  // 与 adjudicate() 同一套调用方式：直接 spawn node 跑 llm.mjs，提示词走 stdin。
  // 超时放宽到 15 分钟：GLM-5.3 等推理型网关对结构化任务可能耗时 5 分钟以上，
  // 原来 300000(5min) 会把还没输出完的进程 SIGTERM 掉 → stdout 为空 → 误判"AI 输出解析失败"。
  const ai = llmText(prompt, "ai-cut", LLM_MODEL);
  const out = ai.stdout || "";
  if (!out.trim()) {
    const why = (ai.stderr || "").trim().split("\n").slice(-2).join(" | ") || ai.error?.message || "无输出";
    console.log(`  ⚠️ AI 初剪调用失败（${why}），落回骨架工程`);
  }
  const j0 = out.indexOf("{"), j1 = out.lastIndexOf("}");
  try {
    const t = JSON.parse(out.slice(j0, j1 + 1));
    (t.cards || []).forEach((c, i) => { if (!c.id) c.id = "cx" + (i + 1); });
    (t.pops || []).forEach((p, i) => { if (!p.id) p.id = "p" + (i + 1); });
    t.meta = { ...skeleton().meta, ...t.meta, cam: { full: camName, preview: camName }, capsFile: "work/caps-full.json" };
    t.boxes = t.boxes || boxes;
    timeline = t;
    console.log(`  ✓ AI 初剪完成：${(t.chapters || []).length} 章节 / ${(t.pops || []).length} 弹字 / ${(t.cards || []).length} 卡片`);
  } catch {
    console.log("  ⚠️ AI 输出解析失败，落回骨架工程（编辑器里可用 ✨AI动效 逐段补）");
  }
} else if (!NO_AI) {
  console.log("  无字幕可供 AI 初剪，生成骨架工程");
}
fs.writeFileSync(path.join(EP, "timeline.json"), JSON.stringify(timeline, null, 1));

// ── 7. 生成预览页 ──
step("生成预览页");
r = run("node", ["gen.js"], { cwd: EP, env: { ...process.env, FULL: "1" } });
if (r.status !== 0) die("gen.js 失败: " + (r.stderr || r.stdout)?.slice(-300));
console.log("  " + (r.stdout || "").trim().split("\n").pop());

console.log(`\n✅ 初剪完成！接下来去定剪：
   npm run dev
   打开 http://127.0.0.1:5178/editor.html → 左上角选「${NAME}」
   （AI 剪的每个元素都在时间轴上，拖谁改谁——你说了算）`);

// 收尾记账（失败路径由 guardExit 兜底）
const _u = finishUsage(USAGE);
if (_u) console.log(`   本轮花费 ¥${_u.total.toFixed(4)}（模型 ¥${_u.llmCost.toFixed(4)} · 转写 ¥${_u.asrCost.toFixed(4)}）`);
