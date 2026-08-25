# @lnyanhongyan/dsh-fetch-url

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

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:lnyanhongyan/dsh-fetch-url

# 从本地目录安装（开发用）
dsh plugin --profile web add E:/Projects/DSH/plugins/dsh-fetch-url
```

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

### Q: 其他窗口没有该工具？
A: profile 未装 / 未重启；确认 `dsh.profile.bundles` 与符号链接。

### Q: 如何卸载？
```bash
dsh plugin --profile web remove @lnyanhongyan/dsh-fetch-url
# 重启 DSH
```

## 📄 许可证

[MIT](LICENSE)

## 🔗 相关资源

- [DeepSeek Harness 文档](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 插件开发流程](IMPLEMENT.md)
- [GitHub 仓库](https://github.com/lnyanhongyan/dsh-fetch-url)