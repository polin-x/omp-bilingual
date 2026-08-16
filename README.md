# omp-bilingual

Oh My Pi 插件：把模型回复里的**英文段落**译成中英对照，原文不动。

默认用 Google 免费接口，不用 key。也可换成 DeepSeek 或腾讯混元。随时开关，不改 OMP 源码，升级 CLI 不会把它冲掉。

仓库：https://github.com/polin-x/omp-bilingual

## 它做什么

| 位置 | 行为 |
|---|---|
| thinking 斜体框 | 英文下面紧跟一行中文：左侧 `│`，accent 色 |
| 回合结束 | 若还有未译的英文散文，下方追加一张对照卡 |
| 不译 | 代码块、`$` 命令、路径、GFM 表格、标题、已是中文的段落 |
| 不进主模型 | 译文不 `steer`、不进下一轮 `convertToLlm` |

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

然后**重开 omp 会话**。扩展模块不会被 `/reload-plugins` 热加载。状态栏应出现 `译:google (free)`。

```bash
omp plugin disable omp-bilingual
omp plugin enable omp-bilingual
```

## 操作

```
/bilingual on
/bilingual off
/bilingual google
/bilingual deepseek
/bilingual hunyuan
/bilingual target zh-CN
/bilingual status
```

`/bilingual` 写入 `~/.omp/agent/omp-bilingual.json`（`PI_CODING_AGENT_DIR` 会改这个目录）。

```bash
omp plugin config set omp-bilingual backend deepseek
omp plugin config set omp-bilingual deepseekApiKey sk-...
omp plugin config list omp-bilingual
```

### 翻译源

**Google（默认）**  
无需 key。走 `translate.googleapis.com`，机翻，专有名词可能不准。

**DeepSeek**

```bash
export DEEPSEEK_API_KEY=sk-...
/bilingual deepseek
```

默认模型 `deepseek-v4-flash`。

**腾讯混元**

```bash
export HUNYUAN_API_KEY=...
/bilingual hunyuan
```

默认 `https://api.hunyuan.cloud.tencent.com/v1` + `hunyuan-turbos-latest`。  
TokenHub：`TOKENHUB_API_KEY`，`hunyuanBaseUrl` 改成 `https://tokenhub.tencentmaas.com/v1`，模型例如 `hy3`。

密钥优先读环境变量，其次本地 json，再其次 `omp plugin config`。不要把 key 提交进 git。

## 已知限制

- 工具跑完后 host 会重建 transcript，**工具前的 thinking 译文可能被拆掉**。工具后、尚未重建的 thinking 能留下。
- 终局回复已经是中文时，不会出对照卡。
- 对照卡在整轮 idle 后才贴，避免译文 `steer` 进主模型。
- Google 免费接口非正式产品 API，可能限流或抽风。

## 发布

插件：https://github.com/polin-x/omp-bilingual  
Marketplace：https://github.com/polin-x/omp-plugins（catalog 名 `polin-plugins`）

OMP 没有统一官方总店。别人加你的 marketplace 即可一键装。catalog 里的 npm 源目前装不了，继续用 GitHub 源。
