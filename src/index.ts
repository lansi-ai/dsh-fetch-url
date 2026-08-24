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