# 使用文档

[返回 README](../README.md) · [术语说明](../CONTEXT.md)

## Windows 免安装版

从 [Releases](https://github.com/J0n-Pan/ai-firstcut/releases/latest) 下载 Windows x64 压缩包，解压到当前用户有写入权限的目录，然后在资源管理器中双击 `启动 AI初剪工作台.cmd`。

安装包内置 Node.js、FFmpeg / ffprobe 和 uv。Python 运行时与转写依赖由 uv 按需准备；首次使用需要联网，具体耗时取决于网络。依赖缓存位于安装目录的 `runtime/uv-cache`、`runtime/uv-python`。

服务启动后会打开 <http://127.0.0.1:5179>。保留启动窗口，关闭它会停止服务。重复启动时，如果端口已有实例，启动器会打开已有实例的页面。

### 一次完整的剪辑流程

1. 在左侧填写阿里云百炼（DashScope）API Key，点击“保存到本机”，可用“测试连接”检查配置。
2. 拖入原片。导入后自动开始转写、分析剪点和生成初剪。
3. 在预览、时间轴与审核列表中检查结果，逐条选择“保留 / 剪掉”。
4. 点击“应用并重剪”，按当前决定生成新版本。
5. 在顶部切换历史版本对比；“打开成片”打开当前查看的版本，“打开文件夹”打开导出目录。

“更改”用于选择导出目录；更改后会把当前成片复制到新目录。失败的任务不会自动反复重跑，可查看处理日志后点击“重试”。

### 重剪与 AI 重跑

| 操作 | 何时使用 | 处理方式 |
|---|---|---|
| 应用并重剪 | 修改了“保留 / 剪掉”决定 | 复用已有剪辑计划，不重新调用转写和大模型 |
| AI 剪辑 | 希望重新分析原片，或补充具体要求 | 从原片重新转写、判断并生成新版本，需要联网调用云端服务 |

补充要求是对 AI 的指引，不保证每次都按预期生效，生成后仍需审核。普通重剪只调整现有计划内的取舍；要重新分析原片，应使用“AI 剪辑”。

## 数据、版本与云端服务

默认数据位于程序目录：

```text
uploads/<工程名>/                    原片副本
episodes/<工程名>/work/              转写、剪辑计划、审核决定、日志
episodes/<工程名>/hf/assets/         工程内的成片版本
exports/                            导出的成片
.env                                API Key、导出目录等本机配置
```

- AI 重跑成功后，工程内只保留最近 3 版成片；导出目录的留档不会自动删除。导出文件仍可能持续占用磁盘空间。
- 迁移时保留整个程序目录，并检查自定义导出目录中的文件。使用绝对路径的自定义配置在另一台电脑上可能需要重新设置。
- 原片副本保存在本机。默认云端转写会上传从原片提取的音频；相关转写文本会发送给云端模型，用于判断剪点。
- API Key 保存在本机 `.env` 中，调用云端服务时用于鉴权。`.env` 和运行产物已列入 `.gitignore`。

## 从源码运行

需要：

- Node.js 18 或更新版本。
- FFmpeg 和 ffprobe，可通过 `PATH` 找到，或在启动前指定 FFmpeg 路径。
- [uv](https://docs.astral.sh/uv/)，用于准备 Python 依赖。

```bash
git clone https://github.com/J0n-Pan/ai-firstcut.git
cd ai-firstcut
node scripts/studio-server.mjs
```

无需执行 `npm install`。打开 <http://127.0.0.1:5179>，在页面保存 API Key 后即可导入原片。

源码中的 `studio/` 是页面，`scripts/studio-server.mjs` 是本地服务，`firstcut/` 是剪辑引擎。默认只监听 `127.0.0.1`。

## 配置

### 界面配置

API Key 和导出目录通过页面设置，保存在程序目录的 `.env`。导出目录对应 `XUNJIAN_EXPORT_DIR`；服务从 `.env` 读取它，路径不可用时会尝试回退到默认 `exports/`。

源码运行时也可参考 [`.env.example`](../.env.example) 手动配置 Key。

### 服务启动参数

以下参数应在启动服务前设置到进程环境中：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `STUDIO_PORT` | `5179` | 本地服务端口 |
| `XUNJIAN_FFMPEG` | `ffmpeg` | FFmpeg 路径；ffprobe 从同目录推断 |

例如在 PowerShell 中从源码启动：

```powershell
$env:STUDIO_PORT = "5179"
$env:XUNJIAN_FFMPEG = "C:\tools\ffmpeg\bin\ffmpeg.exe"
node scripts/studio-server.mjs
```

免安装版的启动脚本已设置包内 FFmpeg 和 uv 路径，通常不需要手动配置。

### 剪辑引擎参数

剪辑引擎会读取 `.env`；同名参数已存在于进程环境时，保留进程环境的值。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `XUNJIAN_ASR_PROVIDER` | `auto` | `cloud` / `local` / `auto`；auto 有 Key 时使用云端转写 |
| `XUNJIAN_UV` | `uv` | uv 可执行文件路径 |
| `XUNJIAN_PYTHON` | 空 | 指定已有依赖的 Python；留空使用 uv |
| `XUNJIAN_LLM_MODEL` | `qwen-plus` | 语义裁决模型 |
| `XUNJIAN_LLM_BASE` / `XUNJIAN_LLM_KEY` | 百炼兼容端点 / DashScope Key | 自定义兼容模型服务 |
| `XUNJIAN_RULES` | `firstcut/rules.json` | 初剪引擎的规则文件路径 |

阈值与默认编码参数集中在 [`firstcut/rules.json`](../firstcut/rules.json)。`XUNJIAN_RULES` 可指定初剪和 AI 重跑使用的规则文件。普通重剪仍读取 `firstcut/rules.json`，速度与淡入淡出参数沿用已有剪辑计划。

高级用法支持 `local` 转写，需要先准备 faster-whisper 模型和额外依赖。本地转写与云端语义裁决是两部分；选择本地转写不代表所有 AI 功能都已离线运行。

## 导出编码

当前默认值：

| 项目 | 设置 |
|---|---|
| 视频编码 | H.264（`libx264`），CRF 18，preset fast |
| 像素格式 | `yuv420p`，8bit |
| GOP | 15 帧 |
| 音频编码 | AAC 192k |
| 播放速度 | 1.0 倍，默认不提速 |
| 拼接音频淡入淡出 | 30ms |

流程另生成一份响度归一的 `work/voice-norm.wav` 中间文件，参数为 `I=-14:TP=-1.5:LRA=11`、采样率 48000Hz。当前没有将这份音频重新封装回导出的 MP4，因此不能把它理解为“成片已归一到 -14 LUFS”。

输出大小随原片、时长和编码结果变化。固定的 `yuv420p` 不保证保留 10bit / HDR；当前工具只提供剪辑层，不包含字幕烧录、动效或章节页。

## 常见问题

### 点击“更改”或“打开文件夹 / 成片”没有窗口

这些操作依赖运行服务的 Windows 桌面。如果服务由隔离桌面、受限账号或后台环境启动，系统窗口可能不可见。

先退出原服务，再由当前登录用户在 Windows 资源管理器中双击启动脚本。只重复启动可能仍连接到原先占用端口的实例。系统文件夹选择器目前仅支持 Windows；其他系统可在 `.env` 中设置 `XUNJIAN_EXPORT_DIR`。

### 页面打不开或提示端口占用

确认启动窗口仍在运行，访问的端口与 `STUDIO_PORT` 一致。默认地址为 <http://127.0.0.1:5179>。端口被占用时，先确认已有进程是否就是要使用的工作台。

### 转写失败或提示 Key 无效

检查 Key 是否已保存，用页面的“测试连接”检查连通性，再展开处理日志查看具体错误。云端服务需要联网；首次使用还需要下载依赖。

### 多个视频同时处理很慢

当前没有批量任务队列，多条原片同时处理会竞争本机资源。可逐条处理，并留意导出留档占用的磁盘空间。
