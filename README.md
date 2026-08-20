# omp-bilingual

Oh My Pi 插件：把模型回复里的**英文段落**译成中英对照，原文不动。

默认用 Google 免费接口，不用 key。也可换成 DeepSeek 或腾讯混元。随时开关，不改 OMP 源码，升级 CLI 不会把它冲掉。

仓库：https://github.com/polin-x/omp-bilingual

## 它做什么

| 位置 | 行为 |
|---|---|
| thinking 斜体框 | 回合结束后补一行中文。只画在 TUI，不写 session |
| 终局英文回复 | 编辑器上方一张对照卡（widget）。不 `sendMessage` |
| 中文提问 | 发完后一张学习卡：英文说法 + 记忆技巧。不进主模型 |
| 不译 | 代码块、`$` 命令、路径、GFM 表格、标题、已是中文的段落 |
| 不进主模型 | 不写 custom 消息进 context，不 `steer` |

行内 `` `code` ``、`**粗体**` 先占位再译，译完还原。

## 安装

从 Git：

```bash
omp plugin install github:polin-x/omp-bilingual
```

从 marketplace：

```
/marketplace add polin-x/omp-plugins
/marketplace install bilingual@polin-plugins
```

```bash
omp plugin marketplace add polin-x/omp-plugins
omp plugin install bilingual@polin-plugins
```

本机开发：

```bash
omp plugin link /path/to/omp-bilingual
```

然后**重开 omp 会话**。扩展模块不会被 `/reload-plugins` 热加载。状态栏应出现 `译:google`。

## 操作

```
/bilingual on
/bilingual off
/bilingual status
/bilingual configure
/bilingual google
/bilingual deepseek
/bilingual hunyuan
```

`/bilingual configure` 用 TUI 选开关、后端、密钥、模型、混元 Base URL。密钥和模型写到 `~/.omp/agent/omp-bilingual.json`，**不读环境变量**。

`settings` 里的 **learn**（默认开）：中文提问发出后，出一张学习卡。有 LLM 时给自然英文、可直接再用的短 prompt，以及谐音/拆词/场景记忆；只有 Google 时先给对照译文。不进主模型。**review** 继续只改英文提问。

已有密钥时，密钥输入框留空表示保持不变。模型可选预设或 `custom` 手输。

### 翻译源

**Google（默认）**  
无需 key。走 `translate.googleapis.com`。`configure` 里可改 target（默认 `zh-CN`）。

**DeepSeek**  
`configure` 里填 API key，模型默认 `deepseek-v4-flash`，也可选 `deepseek-v4-pro` 或自定义。

**腾讯混元**  
`configure` 里填 key。Base URL 可选官方 `https://api.hunyuan.cloud.tencent.com/v1` 或 TokenHub `https://tokenhub.tencentmaas.com/v1`，模型可选 `hunyuan-turbos-latest` / `hy3` 或自定义。

**Custom**
任意 OpenAI 兼容接口，可配多个。`/bilingual settings` → `customs` 添加/编辑/删除。例如 `https://api.openai.com/v1` + `gpt-4o-mini`，或 OpenRouter / 自建 vLLM。旧的单个 `customApiKey` / `customBaseUrl` / `customModel` 会在加载时迁进列表。

**Race**
`/bilingual settings` → `customs` 里的 LLM **并行竞速**。全部失败后才走 fallback（`>`）。译文末尾：` · b.ai 320ms`。状态栏：`译:b.ai/deepseek-v4-flash|ds-v4-flash/deepseek-v4-flash>google>deepseek-v4-flash`。

不要把 json 里的 key 提交进 git。


## 已知限制

- 翻译在整轮 `agent_end` 之后后台跑。`message_end` 只收集原文，不发网、不 await。
- 不注册 `context` 钩子，避免每轮 LLM 前 `structuredClone` 整份历史。
- 旧会话里已经写入的对照卡仍在 JSONL。host 会把它们当 developer 消息。升级后请 `/new`。
- 工具跑完后 host 会重建 transcript，**工具前的 thinking 译文可能被拆掉**。
- 终局回复已经是中文时，不显示对照。
- Google 免费接口非正式产品 API，可能限流或抽风。

## 发布

插件：https://github.com/polin-x/omp-bilingual  
Marketplace：https://github.com/polin-x/omp-plugins（catalog 名 `polin-plugins`）

OMP 没有统一官方总店。别人加你的 marketplace 即可一键装。catalog 里的 npm 源目前装不了，继续用 GitHub 源。
