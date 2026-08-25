# @lansi-ai/dsh-fetch-url

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)

> DeepSeek Harness (DSH) 抓取工具插件 — 注册模型可调用的 `fetch_url` 工具，抓取任意 URL（境内直连 / 境外走代理），返回有界摘要。

本插件给 DSH 注册一个**工具** `fetch_url`：Agent（模型）直接调用即可抓取网页/API，无需每次手写抓取逻辑。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 境内直连 | 用 Node 内建 TLS（openssl），不依赖 Windows schannel，受限沙箱下也可用 |
| 🔀 境外代理 | HTTP CONNECT 隧道走 `127.0.0.1:7890` 代理（先消费 `200 Connection established` 头再 TLS 握手） |
| 📄 有界摘要 | JSON 就地压缩，正文截断到 `maxBytes`（默认 2000 字符） |
| 📝 自定义头 | 支持传入 `headers`（仅字符串值生效） |
| 💾 落盘 | 传 `outFile` 可把完整正文写入本地文件 |
| ⏱️ 超时控制 | 默认 20s 超时，支持 AbortSignal 取消 |

## 🚀 快速开始

### 安装

安装方式决定 `fetch_url` 工具对哪些会话可见，分**两种**：**全局安装**（所有预设的会话可见）和**预设安装**（只有加入指定 preset 的会话可见，类似 `pwsh` 只在部分 preset 出现）。

#### 方式一：全局安装（默认，所有预设可见）

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:lansi-ai/dsh-fetch-url

# 从本地目录安装（开发用；路径相对你所在的目录）
dsh plugin --profile web add ./dsh-fetch-url

# 或从本地打包文件安装
dsh plugin --profile web add ./lansi-ai-dsh-fetch-url-0.1.0.tgz
```

> 说明：这会把它写进 profile 的 `dsh.profile.bundles`（全局插件层）。按照 DSH 的作用域链 `agent → preset → global`，全局层工具**每个 preset 的 agent 都会继承**——所有会话都能看到 `fetch_url`。

#### 方式二：预设（Preset）安装（只对特定预设可见）

仅让某个自定义 preset 的会话拥有 `fetch_url`，其它 preset 看不到。步骤：

1. **从 profile 全局层摘除该插件**（若此前已全局装过），避免同名工具在"全局层 + preset 层"重复注册：
   ```bash
   dsh plugin --profile web remove @lansi-ai/dsh-fetch-url
   ```

2. **在目标 preset 的组合文件里加一行**，指向插件入口。自建预设放在 `{DSH_HOME}/.agent-presets/<id>/`，在它的 `agent.cordis.yml` 里追加：
   ```yaml
   - id: fetch-url
     name: '<插件可被加载的入口>'   # 见下方"入口写法"
   ```

3. **重启 DSH**，新建会话时选择该 preset 即可。

> 作用域机制：preset 组合挂载在"常驻 agent scope"上，工具注册进该 preset 层，只有加入它的会话可见（`agent → preset → global` 链上的最近遮蔽）。

**关于"入口写法"（关键）：**

preset 行会让 DSH 直接 `import` 插件模块，因此 `name` 必须是一个 **Node 可加载的模块标识符**：

- ✅ **指向入口文件**（已验证可行；Node 拒绝"目录"导入 `ERR_UNSUPPORTED_DIR_IMPORT`）：
  ```yaml
  name: '<你的插件目录>/lib/index.mjs'
  ```
- ✅ **npm 包名**（当 DSH 能解析它时最可移植）：
  ```yaml
  name: '@lansi-ai/dsh-fetch-url'
  ```
  > 注意：DSH 的 preset 加载器用 **harness 安装目录**做裸包名解析（`harnessBase`），不是 profile 的 `node_modules`。要让裸包名可用，需把插件装到 harness 可解析的位置（如 `link:` 进 harness 的 node_modules）或发布到 npm。

❌ **不要写目录**：`name: '<你的插件目录>'`（Node 报 `ERR_UNSUPPORTED_DIR_IMPORT`，会导致该行 inactive、整个 preset 挂载失败，会话会退回默认预设）。

### 重启 DSH

```bash
dsh web --port 3081
```

重启后 `fetch_url` 工具即出现在模型可用工具列表中，可直接调用。

## 🚀 使用方法

安装并重启 DSH 后，在任意会话中模型可直接调用：

```
fetch_url(url="https://api.github.com/rate_limit", proxy="127.0.0.1:7890")
# 境外目标走代理 -> { ok:true, status:200, ... }

fetch_url(url="https://www.qq.com/")
# 境内目标直连 -> { ok:true, status:200, ... }
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 要抓取的 URL（http/https） |
| `proxy` | string | - | HTTP 代理 `host:port`（境外目标，如 `127.0.0.1:7890`）；境内直连省略 |
| `headers` | object | - | 附加请求头（字符串值，如 `{"Accept": "application/vnd.github+json"}`） |
| `maxBytes` | number | - | 返回正文最大字符数（默认 2000） |
| `outFile` | string | - | 把完整正文写入本地文件 |

### 返回

```json
{ "ok": true, "status": 200, "contentType": "application/json", "bytes": 427, "body": "..." }
```

失败时返回 `{ "ok": false, "error": "..." }`。

## 📦 项目结构

```
dsh-fetch-url/
├── src/
│   └── index.ts              # 插件主体：注册 fetch_url 工具
├── lib/
│   ├── index.mjs             # Host ESM 产物
│   └── index.d.mts           # 类型声明
├── cordis.patch.yml          # DSH 安装配置
├── package.json
├── tsconfig.json
├── tsdown.config.ts          # 单产物 ESM 构建
├── README.md                 # 本文档
└── IMPLEMENT.md              # 实现文档（自包含，可在任意 DSH 窗口照做）
```

## 🛠️ 开发

```bash
# 安装依赖
npm install --no-audit --no-fund

# 类型检查
npx tsc -p tsconfig.json --noEmit

# 构建
npm run build
```

## 📋 依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `@deepseek-ai/cordis` | ^4.0.1 | Cordis 框架 |
| `@deepseek-ai/dsh-tools` | ^0.1.0-rc.7 | 工具注册（defineTool） |

## ❓ 常见问题

### Q: 报 `wrong version number`？
A: CONNECT 后没等代理 200 头就 TLS——代码已处理；若仍出现，检查代理是否真的是 HTTP 代理。

### Q: GitHub 返回 400？
A: 缺 `Host` 头——代码已补显式 `Host`。

### Q: 其他窗口/某些预设没有该工具？
A: 这是正常的——工具到底在哪些会话可见，取决于你用的是**全局安装**还是**预设安装**（见上文"安装"）。若预期全局可见却没有，检查 `dsh.profile.bundles` 里是否有它、是否已重启；若预期只在某 preset 可见，确认对应 preset 的组合文件里加了 `fetch-url` 行。

### Q: 如何卸载？

**全局安装**卸载：
```bash
dsh plugin --profile web remove @lansi-ai/dsh-fetch-url
# 重启 DSH
```

**预设安装**卸载：从该 preset 的 `agent.cordis.yml` 里删掉 `fetch-url` 那一行，重启 DSH 即可（不影响插件的代码，只是不再被该 preset 装载）。

## 📄 许可证

[MIT](LICENSE)

## 🔗 相关资源

- [DeepSeek Harness 文档](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 插件开发流程](IMPLEMENT.md)
- [GitHub 仓库](https://github.com/lansi-ai/dsh-fetch-url)