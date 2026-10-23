# AI 初剪工作台 · ai-firstcut

上传一条口播原片，自动转写、找可疑剪点、出初剪成片；然后你逐条审核、改决定、重剪导出。
跑在本机，零 npm 依赖，只绑 `127.0.0.1`。

```
上传原片 → 转写（字级时间戳）→ 语义裁决（重说 / 卡壳 / 语气词 / 冗余）
        → 剪切转码 → 审核时间轴 → 逐条改决定 → 重剪导出（v1 / v2 / v3 …）
```

## 下载（Windows 免安装版）

**不想装环境就直接下**：[`AI-FirstCut-Studio-1.0.0-win-x64.zip`](https://github.com/J0n-Pan/ai-firstcut/releases/latest)
（约 105 MB）—— 解压即用，内置 Node 22 / FFmpeg 6.1 / uv；双击 `启动 AI初剪工作台.cmd` 即开。
详见 [v1.0.0 发布说明](https://github.com/J0n-Pan/ai-firstcut/releases/tag/v1.0.0)。
## 界面

顶栏是唯一的素材入口：左边「AI初剪工作台」+ 素材下拉（一条素材 = 一个工程，切换即换整版面），
中间是五步进度，右边是 API 状态与「打开成片」。

三栏主体：

| 左栏 | 中栏 | 右栏 |
|---|---|---|
| 上传 / API Key / 导出地址 / 处理日志 | 成片预览 + 播放倍速 + 审核时间轴 | 审核项列表：每条剪点可改「保留 / 剪掉」 |

处理日志可展开看完整日志（折叠时只露最新几行）；导出地址可「更改」到任意文件夹，
改完会把当前这一版成片一并复制过去。

## 快速开始

需要三样东西：

| 依赖 | 说明 |
|---|---|
| **Node ≥ 18** | 服务与剪辑引擎只用内置模块，**不需要 `npm install`** |
| **ffmpeg / ffprobe** | 在 `PATH` 里，或用 `XUNJIAN_FFMPEG` 指定绝对路径 |
| **uv** | <https://docs.astral.sh/uv/>，剪的时候由它临时装 Python 依赖（dashscope / requests / numpy / jieba …），无需手动 pip |

再加一把**阿里云百炼（DashScope）API Key**：<https://bailian.console.aliyun.com/> 实名认证后在「API-KEY」页创建。
转写与语义裁决共用这一把。

```bash
git clone https://github.com/J0n-Pan/ai-firstcut.git
cd ai-firstcut
npm run studio        # → http://127.0.0.1:5179
```

打开页面后：把 Key 填进左栏「API Key」→ 保存 → 拖入原片。
**没有「开始剪辑」按钮**，素材落盘即自动跑第一轮。

## 目录

```
studio/                前端三件套（原生 HTML/CSS/JS，无构建）
  index.html
  app.js
  app.css
scripts/studio-server.mjs   本地服务：上传 / 保存 Key / 起剪辑 / 审核 / 重剪 / 打开文件夹
firstcut/              剪辑引擎
  run.mjs              主流程：探测 → 气口 → 四处剪点 → 剪切转码（--cut-only 到此为止）
  reexport.mjs         按决定重剪，产物逐版留档
  review-clip.mjs      基线计划 ⊕ 决定 → 有效片段表（幂等）
  retake.mjs           重说 / 卡壳 / 语气词的确定性检测
  asr_cloud.py         云端转写（paraformer-v2，字级时间戳）
  asr_and_caps.py      本地转写 + 字幕断行
  llm.mjs              裁决用的 LLM 客户端（失败自动回退算法结果）
  arbiter-prompt-*.md  四类剪点的裁决提示词
  rules.json           阈值与默认参数
```

运行时会就地生成（都在 `.gitignore` 里）：

```
uploads/<key>/<原片>             上传的素材，一条一个目录（同名不覆盖）
episodes/<key>/work/             cut-plan.json / review-queue.json / versions.json / run.log
episodes/<key>/cam-*.mp4         成片
exports/                         默认导出目录（可用「更改」改到别处）
```

## 环境变量

写进 `.env`（界面保存 Key 时自动写），或用系统环境变量覆盖。

| 变量 | 默认 | 作用 |
|---|---|---|
| `STUDIO_PORT` | `5179` | 服务端口（固定绑 `127.0.0.1`） |
| `XUNJIAN_FFMPEG` | `ffmpeg` | ffmpeg 路径，ffprobe 自动同目录推断 |
| `XUNJIAN_PYTHON` | 空 | 指定已装好依赖的 python；留空则用 uv 托管 |
| `XUNJIAN_UV` | `uv` | uv 可执行文件 |
| `XUNJIAN_ASR_PROVIDER` | `auto` | `cloud` / `local` / `auto`（有 Key 走云端，否则本地 faster-whisper） |
| `XUNJIAN_LLM_MODEL` | `qwen-plus` | 裁决模型 |
| `XUNJIAN_LLM_BASE` / `XUNJIAN_LLM_KEY` | 阿里云 | 换别的 OpenAI 兼容厂商 |
| `XUNJIAN_EXPORT_DIR` | `<repo>/exports` | 成片落点 |
| `XUNJIAN_RULES` | `firstcut/rules.json` | 阈值参数表 |

## 成片规格

分辨率、帧率、位深、色域与原片一致，只做重编码：
`libx264 CRF 18 / preset fast / GOP 15`，音频 `AAC 192k` + `loudnorm -14 LUFS`，拼接处 5ms 淡入淡出（消爆音、防转写幻觉）。

实测（1080×1920 / 59.94 / 8bit）：原片 49.95 Mbps → 成片 8.20 Mbps，
对齐帧后 **SSIM 0.990 / PSNR 46.9 dB**，视觉难分辨。
体积从 872MB 降到 98MB，主要来自三处：CRF 18 按主观质量分码率、PCM 1536k 音频转 AAC 192k、
以及丢弃 `rtmd` 相机元数据轨（原片的 14%）。

## 已知边界

- **只跑剪辑层**（`--cut-only`）：不含字幕烧录、动效卡片、章节页。原项目 `ai-xunjian` 的完整渲染链路不在本仓库内。
- 决定只能「保留 → 剪掉」「剪掉 → 保留」，**不能恢复被剪内容的上下文**（前后衔接不重排）。
- 批量上传没有队列，多条同时跑会抢 CPU。
- 失败不自动重跑（避免刷新页面无限重试），页面上给「重试」。
- 系统文件夹选择器**仅 Windows**（PowerShell `FolderBrowserDialog`）；macOS / Linux 请手改 `XUNJIAN_EXPORT_DIR`。
- 每版成片约 90–100MB，版本累积不会自动清理。
- 源是 **10bit / HDR** 时会被固定 `yuv420p` 压成 8bit —— 当前只验证过 8bit SDR。

## 来源与许可

从开源项目 [ai-xunjian](https://github.com/fxl1209739475-fxl/ai-xunjian) 中切出的「剪辑台 + 剪辑引擎」子集，
上游为 MIT，本仓库沿用同一许可证并保留原 `LICENSE`。

Key 只写本机 `.env`（已在 `.gitignore` 中），不上传、不入库；服务只监听 `127.0.0.1`，不对外网开放。
