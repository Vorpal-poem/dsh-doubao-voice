# dsh-doubao-voice 🎤

**DeepSeek Harness 语音输入插件**：接入**火山引擎流式大模型语音识别（豆包 Seed ASR / sauc）**，浏览器采集麦克风 → 经宿主 WebSocket 中继到豆包 → **识别结果流式回填输入框**。

Voice input plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) powered by Volcengine streaming ASR (Doubao Seed ASR).

## 功能 / Features

- 输入框左侧麦克风按钮 + 全局快捷键（默认 `Alt+V`）
- 四态指示：**正在准备中**（转圈）/ **正在听写**（音量动态条）/ **收尾中**（转圈）
- 真流式：16kHz/16bit/单声道 PCM 按 200ms 分块上行，识别文本边说边上屏
- 识别结果**不自动发送**，可编辑确认；取消录音自动回滚
- 中途修正原位替换、多停顿长录音不堆叠（LCP 合并算法，含确定性测试）
- 设置页管理凭据/热词/语言/快捷键/最长录音时长（默认 300s）
- **输出方式**：跟随光标（默认）——写入唤起时焦点所在的可编辑元素，输入框走官方 API；
  无焦点/不可写时写入输入框；**自动写入失败兜底复制到剪贴板**并提示
- 凭据存 `~/.dsh/dsh-doubao-voice.json`（ACL 收紧到当前用户，仅本机可读）

## 安装 / Install

```bash
dsh plugin --profile web add dsh-doubao-voice
# 或本地打包：
dsh plugin --profile web add file:./dsh-doubao-voice-0.2.0.tgz
```

安装后重启 `dsh web`，刷新页面。

## 配置 / Configuration

设置 → 语音输入（豆包）：

- **App ID / Access Token**：火山引擎控制台 → 智能语音 → 流式大模型语音识别
  （兼容旧版控制台鉴权：`X-Api-App-Key` / `X-Api-Access-Key`）
- **Resource ID**：默认 `volc.seedasr.sauc.duration`（豆包流式语音识别模型 2.0 小时版）
- **热词**：逗号/分号分隔，最多 100 个
- **语言**：`zh-CN` / `en-US` / `ja-JP` 等（BCP-47）

也可用环境变量（优先级高于文件）：

```powershell
$env:ARK_APP_ID="你的AppID"
$env:ARK_ACCESS_TOKEN="你的Token"
$env:ARK_RESOURCE_ID="volc.seedasr.sauc.duration"
$env:ARK_LANGUAGE="zh-CN"
$env:ARK_HOTWORDS="芯片,Buck电路"
```

## 架构 / Architecture

```
浏览器 (lib/client.js)                宿主 (lib/index.js)                 火山引擎
麦克风 → 16kHz PCM ──WS 二进制──► registerUpgrade 中继 ──sauc 协议──► 豆包流式 ASR
   ▲   ◄── transcript 流 ──JSON──◄   DoubaoAsrClient   ◄────────────┘
   流式回填输入框（基线 + 累计文本，幂等写入）
```

- 上行：二进制 = 200ms PCM 块（6400B）；文本 `{"type":"end"|"cancel"}`
- 下行：`{"type":"ready"|"transcript",text,isFinal|"error",message|"done",text}`
- 认证走 WebSocket 请求头（Node 原生 WebSocket 不支持自定义头，宿主侧使用 `ws` 库）

## 测试 / Tests

```bash
node test/merge-test.mjs          # 合并算法确定性测试（8 场景：真实序列/中途修订/VAD 分句/增量交替）
node test/writer-guard-test.mjs   # 写入保险（发送后迟到写入拦截）
node test/relay-test.mjs          # mock 豆包全链路中继自测（无需真实凭据）
```

## 致谢 / Credits

- 协议层实现基于 **Proma 桌面端 `doubao-asr-service.ts`** 的调研复刻（二进制帧协议、参数与解析逻辑）
- 接口参数与响应字段对照 **火山引擎官方文档**（单向/双向流式语音识别 WebSocket）实测校准
- 运行依赖：`ws`（WebSocket）

## 免责声明 / Disclaimer

- 社区项目，非 DeepSeek 官方出品，与 DeepSeek / 火山引擎均无隶属关系
- 使用火山引擎服务需遵守其服务条款；Access Token 请妥善保管
- 收录于 [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) 不构成安全背书

## License

MIT © [Vorpal-poem](https://github.com/Vorpal-poem)
