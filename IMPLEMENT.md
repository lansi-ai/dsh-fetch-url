# dsh-fetch-url 插件实现文档（跨窗口复用）

> 本文档自包含：在**任意 DSH 窗口**中，照着本文件即可完整创建、构建、安装
> `@lnyanhongyan/dsh-fetch-url` 插件——注册一个模型可调用的 `fetch_url` 工具
> （直连抓境内网页 / 走 7890 代理抓境外网页，返回有界摘要）。
>
> 文内所有代码**已在本机编译验证通过**（tsc + tsdown 均 exit 0），可直接照抄。
> 如遇与本文不符之处，以本机实际报错为准并回传排查。

---

## 1. 这个插件解决什么

- 给 DSH 注册一个**工具** `fetch_url`：Agent（模型）直接调用即可抓取网页/API，
  无需每次手写抓取逻辑。
- 固化踩坑经验：
  1. 抓取**首选 Node 内建 TLS**（openssl），不依赖 Windows schannel——这是
     curl / Invoke-WebRequest 在受限沙箱下报 `SEC_E_NO_CREDENTIALS` / 超时的根源。
  2. 境外走代理时，**CONNECT 隧道必须先消费代理的 `200 Connection established`
     响应头（到 `\r\n\r\n`）再开始 TLS 握手**，否则报
     `wrong version number`；响应头后同包夹带的 TLS 字节要 `unshift` 回 socket。
  3. 补显式 `Host` 头，避免 GitHub 等返回 400。
- 语义与已有 `tools/fetch-url.cjs`（CLI 版）一致，但作为工具暴露给模型。

## 2. 目录结构（最终产物）

```
E:\Projects\DSH\plugins\dsh-fetch-url\
├── package.json          # 包定义（host-only，无 client）
├── tsconfig.json
├── tsdown.config.ts      # 单产物 ESM 构建
├── cordis.patch.yml      # profile 安装清单
├── src\
│   └── index.ts          # 插件主体：注册 fetch_url 工具
└── lib\                  # 构建产物（index.mjs / index.d.mts）
```

> 提示：构建产物 `lib/` 由 `npm run build` 生成，源码目录不提交 lib 也行，
> 但安装到 profile 时 profile 需要能解析到 `lib/index.mjs`（见第 5 节）。

---

## 3. 文件内容（全部验证过，直接照抄）

### 3.1 `package.json`

```json
{
  "name": "@lnyanhongyan/dsh-fetch-url",
  "version": "0.1.0",
  "description": "DSH plugin that registers a fetch_url tool: fetch any URL (direct for domestic targets, HTTP CONNECT proxy for overseas) and return a bounded text/JSON summary.",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.mjs",
  "types": "lib/index.d.mts",
  "exports": {
    ".": {
      "types": "./lib/index.d.mts",
      "default": "./lib/index.mjs"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.mjs",
    "lib/index.d.mts",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "build": "tsdown --config tsdown.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.7"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.7",
    "@types/node": "^26.2.0",
    "tsdown": "^0.22.14",
    "typescript": "^5.6.0"
  }
}
```

### 3.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "lib"]
}
```

### 3.3 `tsdown.config.ts`

```ts
import { defineConfig } from 'tsdown'

const PLUGIN_ID = '@lnyanhongyan/dsh-fetch-url'

/**
 * Single-artifact host plugin: lib/index.mjs (ESM, node) registers the
 * `fetch_url` tool on ctx.tools. No browser half needed.
 */
export default defineConfig({
  name: `${PLUGIN_ID}/host`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: false,
  deps: {
    neverBundle: (id) =>
      id === '@deepseek-ai/cordis' ||
      id === '@deepseek-ai/dsh-tools' ||
      id.startsWith('@deepseek-ai/dsh-'),
  },
})
```

### 3.4 `cordis.patch.yml`

```yaml
# dsh-fetch-url bundle patch: inserts the host plugin row into the web
# profile roster. The node half (exports ".") registers the fetch_url tool on
# ctx.tools, making it callable by the model in every session of this profile.
# Install with: dsh plugin --profile <name> add @lnyanhongyan/dsh-fetch-url
- insert:
    - id: fetch-url
      name: '@lnyanhongyan/dsh-fetch-url'
```

### 3.5 `src/index.ts`（插件主体，已编译验证）

```ts
/**
 * Host half of dsh-fetch-url.
 *
 * Registers one model-callable tool `fetch_url` on ctx.tools:
 *
 *   fetch_url(url, { proxy?, headers?, maxBytes?, outFile? })
 *   -> { ok, status, contentType, bytes, body, truncated?, file? }  |  { ok:false, error }
 *
 * The execution logic is the battle-tested path from tools/fetch-url.cjs:
 *   - Domestic targets: Node https/http direct (Node's own OpenSSL TLS, no
 *     Windows schannel dependency — this is what made curl/Invoke-WebRequest
 *     fail under the sandbox).
 *   - Overseas targets: HTTP CONNECT tunnel through a proxy (default
 *     127.0.0.1:7890). Critical ordering: consume the proxy's
 *     "200 Connection established" header (up to \r\n\r\n) BEFORE the TLS
 *     handshake, and unshift any TLS bytes that arrived in the same packet.
 *
 * Responses are summarized in place (JSON is compacted) so the model gets a
 * bounded preview instead of a full page dump.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as fs from 'node:fs'
import { URL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_BYTES = 2000

interface FetchResult {
  ok: boolean
  status?: number
  contentType?: string
  bytes?: number
  body?: string
  truncated?: boolean
  file?: string
  error?: string
}

/** Direct request (domestic target). */
function directRequest(u: URL, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; contentType?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      host: u.hostname,
      port: u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fetch-url', Connection: 'close' }, headers),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'] as string | undefined, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

/**
 * Request through an HTTP CONNECT proxy tunnel (overseas target).
 * Ordering is critical: read the proxy's \r\n\r\n-terminated response first,
 * then start TLS; unshift any TLS bytes that arrived with the header.
 */
function proxiedRequest(u: URL, headers: Record<string, string>, timeoutMs: number, proxyHost: string, proxyPort: number): Promise<{ status: number; contentType?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const targetHost = u.hostname
    const targetPort = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    const proxyReq = net.connect(proxyPort, proxyHost, () => {
      proxyReq.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let proxyBuf = ''
    let tunnelUp = false
    proxyReq.on('data', (d) => {
      if (tunnelUp) return
      proxyBuf += d.toString()
      const idx = proxyBuf.indexOf('\r\n\r\n')
      if (idx === -1) return // proxy header not fully received yet
      const head = proxyBuf.slice(0, idx)
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        reject(new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`))
        proxyReq.destroy()
        return
      }
      tunnelUp = true
      const rest = Buffer.from(proxyBuf.slice(idx + 4), 'utf8')
      if (rest.length > 0) proxyReq.unshift(rest)
      const socket = tls.connect({ socket: proxyReq, servername: targetHost, ALPNProtocols: ['http/1.1'] }, () => {
        const req = https.request({
          createConnection: () => socket,
          host: targetHost,
          path: u.pathname + u.search,
          method: 'GET',
          headers: Object.assign({ Host: targetHost, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fetch-url', Connection: 'close' }, headers),
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'] as string | undefined, body: Buffer.concat(chunks) }))
        })
        req.on('error', reject)
        req.end()
      })
      socket.on('error', reject)
    })
    proxyReq.on('error', reject)
    proxyReq.setTimeout(timeoutMs, () => { proxyReq.destroy(new Error('proxy connect timeout')) })
  })
}

/** Parse a "host:port" proxy string (port defaults to 7890). */
function parseProxy(proxy: string): { host: string; port: number } {
  const idx = proxy.lastIndexOf(':')
  if (idx === -1) return { host: proxy, port: 7890 }
  const host = proxy.slice(0, idx)
  const port = Number(proxy.slice(idx + 1))
  return { host, port: Number.isFinite(port) && port > 0 ? port : 7890 }
}

/** Summarize a body: JSON is compacted, then bounded to maxBytes. */
function summarize(body: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const text = body.toString('utf8')
  let out = text
  try {
    out = JSON.stringify(JSON.parse(text)) // compact JSON if parseable
  } catch { /* keep raw */ }
  if (out.length <= maxBytes) return { text: out, truncated: false }
  return { text: out.slice(0, maxBytes), truncated: true }
}

async function fetchUrl(args: { url: string; proxy?: string; headers?: Record<string, unknown>; maxBytes?: number; outFile?: string }, exec: { signal?: AbortSignal }): Promise<FetchResult> {
  let u: URL
  try {
    u = new URL(args.url)
  } catch {
    return { ok: false, error: `invalid URL: ${args.url}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${u.protocol} (only http/https)` }
  }
  const timeoutMs = DEFAULT_TIMEOUT_MS
  const maxBytes = args.maxBytes !== undefined && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX_BYTES
  // Only string-valued headers are forwarded; anything else is dropped.
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    if (typeof v === 'string') headers[k] = v
  }

  // If a signal is provided, respect it: destroy in-flight requests.
  const signal = exec.signal
  const withAbort = <T>(p: Promise<T>): Promise<T> => {
    if (!signal) return p
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => { reject(new Error('aborted')) }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v) }, (e) => { signal.removeEventListener('abort', onAbort); reject(e) })
    })
  }

  try {
    let res: { status: number; contentType?: string; body: Buffer }
    if (args.proxy) {
      const { host, port } = parseProxy(args.proxy)
      res = await withAbort(proxiedRequest(u, headers, timeoutMs, host, port))
    } else {
      res = await withAbort(directRequest(u, headers, timeoutMs))
    }
    const { text, truncated } = summarize(res.body, maxBytes)
    const result: FetchResult = {
      ok: true,
      status: res.status,
      contentType: res.contentType,
      bytes: res.body.length,
      body: text,
      ...truncated ? { truncated } : {},
    }
    if (args.outFile) {
      try {
        fs.writeFileSync(args.outFile, res.body)
        result.file = args.outFile
      } catch (error) {
        result.error = `body written but outFile failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'fetch_url',
    description: [
      'Fetch a URL and return a bounded summary of the response (status, content-type, body preview).',
      'Use for retrieving specific web pages or API endpoints. For domestic (China) targets, omit proxy. For overseas targets (GitHub, npm, Google, etc.), pass proxy like "127.0.0.1:7890" (the local HTTP proxy; must be confirmed available first).',
      'JSON responses are compacted; body is truncated to maxBytes (default 2000).',
      'Pass headers as an object of string values, e.g. {"Accept": "application/vnd.github+json"}.',
      'Pass outFile to also write the full body to a local file.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to fetch (http or https).' },
      proxy: { type: 'string', description: 'HTTP proxy "host:port" for overseas targets (e.g. "127.0.0.1:7890"). Omit for direct connection.' },
      headers: { type: 'object', additionalProperties: true, description: 'Extra request headers as string values (e.g. {"Accept": "application/vnd.github+json"}).' },
      maxBytes: { type: 'number', description: `Max response characters to return (default ${DEFAULT_MAX_BYTES}).` },
      outFile: { type: 'string', description: 'Optional local file path to write the full response body to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'number' },
          contentType: { type: 'string' },
          bytes: { type: 'number' },
          body: { type: 'string' },
          truncated: { type: 'boolean' },
          file: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: FetchResult) => {
        if (!value.ok) return [{ type: 'text', text: `fetch failed: ${value.error ?? 'unknown error'}` }]
        const lines = [`HTTP ${value.status} | ${value.contentType ?? '(no content-type)'} | ${value.bytes} bytes${value.truncated ? ' (truncated)' : ''}`]
        if (value.file) lines.push(`full body written to: ${value.file}`)
        if (value.body) lines.push(value.body)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      return fetchUrl(args, exec)
    },
    presentCall: (args) => {
      const url = typeof (args as { url?: unknown }).url === 'string' ? (args as { url: string }).url : ''
      return {
        card: 'generic',
        title: `fetch ${url}`,
        kind: 'fetch',
        rawInput: url,
        content: [{ type: 'text', text: `fetching ${url}` }],
      }
    },
  }))
}
```

---

## 4. 构建

```powershell
# 在插件目录
cd E:\Projects\DSH\plugins\dsh-fetch-url

# 装依赖（境外 npm 源需要代理；本机 .npmrc 已配 npmmirror 镜像，直连即可）
# 若沙箱下 npm 静默无输出，按沙箱规则对同一条命令升级权限重试
npm install --no-audit --no-fund

# 类型检查 + 构建
npx tsc -p tsconfig.json --noEmit      # 期望 exit 0
npm run build                          # 期望生成 lib/index.mjs
```

> 沙箱提示：在受限 pwsh 里直接跑 `node`/`npm` 可能报 `Access is denied` 或
> 静默无输出——这是文件沙箱拦了 node 子进程，**对同一条命令升级沙箱权限重试**
> 即可（本项目 pwsh 工具支持 `sandbox_permissions: danger-full-access` 重试）。

## 5. 安装到 profile（让所有窗口的 Agent 都能用）

以本机 web profile 为例（路径若不同先确认）：

```powershell
$profilePkg = 'C:\dsh-data\opendesign\profiles\web\package.json'
```

1. **注册为 profile 依赖 + bundle**：编辑 `$profilePkg`，
   - `dependencies` 增加：`"@lnyanhongyan/dsh-fetch-url": "link:E:/Projects/DSH/plugins/dsh-fetch-url"`
   - `dsh.profile.bundles` 数组增加：`"@lnyanhongyan/dsh-fetch-url"`

2. **在 profile node_modules 建立符号链接**（与已有插件一致）：

```powershell
New-Item -ItemType SymbolicLink `
  -Path 'C:\dsh-data\opendesign\profiles\web\node_modules\@deepseek-ai\dsh-fetch-url' `
  -Target 'E:\Projects\DSH\plugins\dsh-fetch-url'
```

3. **重启 DSH web**（侧边栏「重启」按钮，或重启启动命令），使新 bundle 生效。

> 注意：profile 目录在 `C:\dsh-data\...`（会话工作区之外），写它需要按沙箱
> 规则升级权限。

## 6. 验证

重启后，在任意新会话中让模型调用（或直接在对话里问"你有没有 fetch_url 工具"）：

```
fetch_url(url="https://api.github.com/rate_limit", proxy="127.0.0.1:7890")
# 期望返回 { ok:true, status:200, ... }
fetch_url(url="https://www.qq.com/")
# 期望直连成功，status 200
```

检查点：
- 工具出现在模型可用工具列表（名称 `fetch_url`）
- 境内直连：不带 `proxy`
- 境外走代理：带 `proxy: "127.0.0.1:7890"`（按代理规则，境外访问前先与用户确认代理可用）

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `wrong version number` | CONNECT 后没等代理 200 头就 TLS——代码已处理，若仍出现检查代理是否真的是 HTTP 代理 |
| GitHub 返回 400 | 缺 `Host` 头——代码已补显式 `Host` |
| 沙箱下 npm/node 无输出或 Access denied | 升级沙箱权限重试同一条命令 |
| 其他窗口没有该工具 | profile 未装 / 未重启；确认 bundles 数组与符号链接 |
| 工具重名冲突 | `fetch_url` 目前不与官方工具重名；若未来冲突改 `name` 即可 |

---

## 8. 与已有 CLI 工具的关系

- `E:\Projects\DSH\plugins\tools\fetch-url.cjs`：手动 CLI 版（pwsh 直接跑）。
- 本插件：同一逻辑的工具化（模型直接调用）。
- 两者共享相同抓取/隧道逻辑；改动时建议同步。
