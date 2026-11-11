// ffmpeg / ffprobe 定位 —— 全工程唯一一处决定「用哪个 ffprobe」。
//
// 为什么要有这个模块（1.1.5 装机实测）：
//   原来四个入口都是 `process.env.XUNJIAN_FFMPEG || "ffmpeg"`，即**只认环境变量**，
//   而这个变量是由安装包的 runtime/launch.vbs 注入的。一旦用户不是从桌面快捷方式 /
//   「启动 AI初剪工作台.cmd」进入（例如自己 node scripts/studio-server.mjs，或
//   launch.vbs 被安全软件拦掉、直接开 node），进程环境里没有它，就退化成裸 "ffprobe"
//   走 PATH。干净 Windows 的 PATH 里没有 ffmpeg → spawn ENOENT → 报错却只说
//   「ffprobe 失败，请确认已安装 ffmpeg」。
//   而安装包**明明自带** runtime\ffmpeg\ffprobe.exe，只是没人往程序目录看一眼。
//
// 优先级：XUNJIAN_FFMPEG（用户显式指定，且文件真的在）→ 程序目录 runtime/ffmpeg → PATH。
// 返回的 candidates 保留每条候选的检查结果，报错时逐条打印，避免再出现「只说没装，
// 却看不出到底找过哪儿」的排查黑洞。
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";

/** ffmpeg 路径 → ffprobe 路径：只替换**最后一段**（目录名里带 ffmpeg 也不能动） */
export const probePathOf = (p) => String(p).replace(/ffmpeg(?=[^/\\]*$)/, "ffprobe");

const clean = (v) => String(v || "").trim().replace(/^"(.*)"$/, "$1");
const isFile = (p) => {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
};

/**
 * 探测可用的 ffmpeg/ffprobe。
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} o
 *   root: 程序目录（安装包根，含 runtime/ffmpeg）；默认 process.cwd()
 * @returns {{ffmpeg: string, ffprobe: string, source: string, exists: boolean|null,
 *            candidates: Array<{ffmpeg: string, ffprobe: string, source: string, exists: boolean|null}>}}
 */
export function resolveFf({ root = process.cwd(), env = process.env } = {}) {
  const cands = [];

  const envFf = clean(env.XUNJIAN_FFMPEG);
  if (envFf) {
    const envPr = probePathOf(envFf);
    cands.push({ ffmpeg: envFf, ffprobe: envPr, source: "XUNJIAN_FFMPEG", exists: isFile(envPr) });
  }

  // 安装包自带的运行时。ffmpeg.exe 与 ffprobe.exe 同目录，缺一个都算不可用。
  const bFf = path.join(root, "runtime", "ffmpeg", "ffmpeg" + EXE);
  const bPr = path.join(root, "runtime", "ffmpeg", "ffprobe" + EXE);
  cands.push({ ffmpeg: bFf, ffprobe: bPr, source: "程序目录 runtime/ffmpeg", exists: isFile(bFf) && isFile(bPr) });

  // 最后的兜底：交给 PATH。存在性由 spawn 自己报（这里不做 where/which，省一次进程）
  cands.push({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", source: "PATH", exists: null });

  const hit = cands.find((c) => c.exists === true) || cands[cands.length - 1];
  return { ...hit, candidates: cands };
}

/**
 * 把一次失败的调用翻译成人能照着做的话。
 * @param {ReturnType<typeof resolveFf>} ff
 * @param {{input?: string, r?: {status: number|null, error?: Error, stderr?: string}}} o
 */
export function explainFfFailure(ff, { input = null, r = null } = {}) {
  const out = [];
  if (input) {
    const p = path.resolve(input);
    let desc = "文件不存在";
    try {
      const st = fs.statSync(p);
      desc = st.isFile() ? `存在 ${(st.size / 1048576).toFixed(1)}MB` : "存在但不是文件";
    } catch {}
    out.push(`输入   ：${p}（${desc}）`);
  }
  const state = ff.exists === true ? "文件存在" : ff.exists === false ? "文件不存在" : "未验证";
  out.push(`ffprobe：${ff.ffprobe}（来源 ${ff.source}，${state}）`);
  if (r?.error) out.push(`启动错误：${r.error.code || r.error.name || ""} ${r.error.message || ""}`.trim());
  const err = String(r?.stderr || "").trim();
  if (err) out.push(`ffprobe 输出：${err.split("\n").slice(-3).join(" | ").slice(0, 500)}`);
  if (r && r.status !== 0 && !r.error && !err) out.push(`ffprobe 退出码：${r.status}`);
  // 逐条列出找过的位置：哪个缺失、最后退化到哪儿，一目了然
  const tried = ff.candidates.map((c) => {
    const s = c.exists === true ? "可用" : c.exists === false ? "缺失" : "未验证";
    return `${c.source}${c.source === ff.source ? "（当前使用）" : ""}=${s}`;
  });
  if (tried.length) out.push(`已检查：${tried.join("、")}`);
  if (ff.source === "PATH") {
    out.push("安装包正常不该走到 PATH：请从桌面快捷方式或「启动 AI初剪工作台.cmd」启动；仍失败请确认 runtime\\ffmpeg\\ffprobe.exe 未被安全软件隔离，或直接重装。");
  }
  return out;
}
