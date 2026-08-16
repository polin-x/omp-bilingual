# omp-bilingual

Oh My Pi 插件：把模型回复里的**英文段落**译成中英对照，原文不动。

默认用 Google 免费接口，不用 key。也可换成 DeepSeek 或腾讯混元。随时开关，不改 OMP 源码，升级 CLI 不会把它冲掉。

## 它做什么

| 位置 | 行为 |
|---|---|
| thinking 斜体框 | 英文下面紧跟一行中文：左侧 `│`，accent 色 |
| 回合结束 | 若还有未译的英文散文，下方追加一张对照卡 |
| 不译 | 代码块、`$` 命令、路径、GFM 表格、标题、已是中文的段落 |
| 不进主模型 | 译文不 `steer`、不进下一轮 `convertToLlm` |

行内 `` `code` ``、`**粗体**` 先占位再译，译完还原。

## 安装

本机开发（已 link 过可跳过）：

```bash
omp plugin link /path/to/omp-bilingual
```

然后**重开 omp 会话**。扩展模块不会被 `/reload-plugins` 热加载。状态栏应出现 `译:google (free)`。

从 Git 安装（开源后）：

```bash
omp plugin install github:你的用户名/omp-bilingual
# 或
omp plugin install https://github.com/你的用户名/omp-bilingual.git
```

从自己的 marketplace：

```bash
/marketplace add 你的用户名/你的-marketplace
/marketplace install bilingual@你的-marketplace
```

关掉 / 打开：

```bash
omp plugin disable omp-bilingual
omp plugin enable omp-bilingual
```

## 操作

会话里：

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

也可以：

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

默认模型 `deepseek-v4-flash`。可用 `omp plugin config set omp-bilingual deepseekModel …` 改。

**腾讯混元**

```bash
export HUNYUAN_API_KEY=...
/bilingual hunyuan
```

默认 `https://api.hunyuan.cloud.tencent.com/v1` + `hunyuan-turbos-latest`。  
TokenHub：`TOKENHUB_API_KEY`，并把 `hunyuanBaseUrl` 改成 `https://tokenhub.tencentmaas.com/v1`，模型例如 `hy3`。

密钥优先读环境变量，其次本地 json，再其次 `omp plugin config`。不要把 key 提交进 git。

## 已知限制

- 工具跑完后 host 会重建 transcript，**工具前的 thinking 译文可能被拆掉**。工具后、尚未重建的 thinking 能留下。
- 终局回复已经是中文时，不会出对照卡。
- 对照卡在整轮 idle 后才贴，避免译文 `steer` 进主模型。
- Google 免费接口非正式产品 API，可能限流或抽风。

## 传到 GitHub / 插件商店

**可以。** 两条路，互不冲突。

### 1. 只推 GitHub（最简单）

把 `omp-bilingual/` 单独建成仓库（不要把整个 `omp-sol` 工作区塞进去）：

```bash
cd omp-bilingual
git init
git add package.json README.md src
git commit -m "omp-bilingual 0.1.0"
# 在 GitHub 建空仓库后
git remote add origin git@github.com:你的用户名/omp-bilingual.git
git push -u origin main
```

别人装：

```bash
omp plugin install github:你的用户名/omp-bilingual
```

这就是「从 Git 装插件」，不经过官方总店。

### 2. 自己的 OMP marketplace（接近「商店一键装」）

OMP **没有**统一的官方总店审核流。商店是「一个 Git 仓库 + 一份目录」，任何人都可以发：

```
your-marketplace/
  .omp-plugin/
    marketplace.json
  plugins/
    bilingual/          ← 本插件目录，或 catalog 里指向 GitHub
```

`marketplace.json` 最小例子：

```json
{
  "name": "polin-plugins",
  "owner": { "name": "polin" },
  "plugins": [
    {
      "name": "bilingual",
      "description": "英文回复的中英对照卡",
      "version": "0.1.0",
      "source": {
        "source": "github",
        "repo": "你的用户名/omp-bilingual",
        "ref": "main"
      }
    }
  ]
}
```

推到 GitHub 后告诉用户：

```
/marketplace add 你的用户名/your-marketplace
/marketplace install bilingual@polin-plugins
```

注意：catalog 里的 **npm 源目前装不了**（会报 `npm plugin sources are not yet supported`）。用 GitHub / git URL / 仓库内相对路径。

装上后改扩展代码仍要**重开会话**才加载。
