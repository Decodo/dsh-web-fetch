import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'

export const PROVIDER_ID = 'decodo'
export const DEFAULT_BASE_URL = 'https://scraper-api.decodo.com'
export const DEFAULT_TOKEN_ENV = 'SCRAPER_API_TOKEN'
export const INTEGRATION = 'dsh'
export const OUTPUTS = ['markdown', 'html'] as const
export type Output = (typeof OUTPUTS)[number]

export const CODES = {
  TOKEN_MISSING: 'DECODO_TOKEN_MISSING',
  CAP_REACHED: 'DECODO_FETCH_CAP_REACHED',
  AUTH_FAILED: 'DECODO_AUTH_FAILED',
  RATE_LIMITED: 'DECODO_RATE_LIMITED',
  INVALID_REQUEST: 'DECODO_INVALID_REQUEST',
  SCRAPE_FAILED: 'DECODO_SCRAPE_FAILED',
  BAD_RESPONSE: 'DECODO_BAD_RESPONSE',
} as const

export interface Config {
    tokenEnv: string
    baseUrl: string
    output: Output
    maxFetchesPerSession: number
    maxContentChars: number
}

export interface Deps {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

export interface DecodoFetchProvider extends WebFetchProvider {
    readonly fetchCount: number
}

interface ScrapeResult {
  content?: unknown
  status_code?: unknown
  url?: unknown
    help?: unknown
}

interface ApiPayload {
  status?: unknown
  message?: unknown
  errors?: unknown
  results?: unknown
  raw?: string
}

export function defaultConfig(): Config {
  return {
    tokenEnv: DEFAULT_TOKEN_ENV,
    baseUrl: DEFAULT_BASE_URL,
    output: 'markdown',
    maxFetchesPerSession: 200,
    maxContentChars: 200_000,
  }
}

export function resolveConfig(config: Partial<Config> | undefined): Config {
  const cfg: Config = { ...defaultConfig(), ...(config ?? {}) }
  if (typeof cfg.tokenEnv !== 'string' || cfg.tokenEnv.trim() === '') {
    throw new TypeError('web-fetch-decodo: tokenEnv must be a non-empty string')
  }
  if (typeof cfg.baseUrl !== 'string' || !/^https?:\/\//.test(cfg.baseUrl)) {
    throw new TypeError('web-fetch-decodo: baseUrl must be an http(s) URL')
  }
  if (!OUTPUTS.includes(cfg.output)) {
    throw new TypeError(`web-fetch-decodo: output must be one of ${OUTPUTS.join(', ')}`)
  }
  if (!Number.isInteger(cfg.maxFetchesPerSession) || cfg.maxFetchesPerSession < 0) {
    throw new TypeError('web-fetch-decodo: maxFetchesPerSession must be a non-negative integer (0 disables the cap)')
  }
  if (!Number.isInteger(cfg.maxContentChars) || cfg.maxContentChars < 1) {
    throw new TypeError('web-fetch-decodo: maxContentChars must be a positive integer')
  }
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
  return cfg
}

export function createDecodoFetchProvider(config: Partial<Config> | undefined, deps: Deps = {}): DecodoFetchProvider {
  const cfg = resolveConfig(config)
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  let fetches = 0

  const readToken = (): string | undefined => {
    const value = env[cfg.tokenEnv]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  return {
    id: PROVIDER_ID,
        available: () => readToken() !== undefined,
    get fetchCount() {
      return fetches
    },
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      const url = parseUrl(request?.url)
      const token = readToken()
      if (token === undefined) {
        throw new WebError(
          `Decodo web fetch is not configured: set the ${cfg.tokenEnv} environment variable to your Decodo Web Scraping API token`,
          CODES.TOKEN_MISSING,
        )
      }
      if (cfg.maxFetchesPerSession > 0 && fetches >= cfg.maxFetchesPerSession) {
        throw new WebError(
          `Decodo web fetch spend cap reached: ${cfg.maxFetchesPerSession} fetches this session. Raise maxFetchesPerSession in the web-fetch-decodo config or restart dsh to continue`,
          CODES.CAP_REACHED,
        )
      }
      throwIfAborted(signal)
      fetches += 1

      const response = await callApi({ fetchImpl, cfg, token, url, signal })
      const payload = await readJson(response)
      if (!response.ok) throw mapHttpError(response.status, payload, url)
      return toFetchResult({ payload, url, cfg })
    },
  }
}

function parseUrl(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new WebError('web fetch needs a non-empty url', 'WEB_INVALID_URL')
  }
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${parsed.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  return parsed.toString()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw abortError(signal.reason)
}

function abortError(reason: unknown): WebError {
  if (isNamed(reason, 'TimeoutError')) {
    return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: reason })
  }
  return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: reason })
}

function isNamed(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && (value as { name?: unknown }).name === name
}

async function callApi({ fetchImpl, cfg, token, url, signal }: {
  fetchImpl: typeof fetch
  cfg: Config
  token: string
  url: string
  signal: AbortSignal | undefined
}): Promise<Response> {
  const body = { url, markdown: cfg.output === 'markdown' }
  try {
    return await fetchImpl(`${cfg.baseUrl}/v2/scrape`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-integration': INTEGRATION,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal.reason)
    if (isNamed(error, 'AbortError') || isNamed(error, 'TimeoutError')) throw abortError(error)
    throw new WebError(`could not reach the Decodo API: ${describe(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

async function readJson(response: Response): Promise<ApiPayload | undefined> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as ApiPayload
  } catch {
    return { raw: text }
  }
}

function mapHttpError(status: number, payload: ApiPayload | undefined, url: string): WebError {
  const detail = apiMessage(payload)
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401 || status === 403) {
    return new WebError(`Decodo authentication failed (HTTP ${status})${suffix}. Check the Web Scraping API token`, CODES.AUTH_FAILED)
  }
  if (status === 429) {
    return new WebError(`Decodo rate limit reached (HTTP 429)${suffix}. Retry later`, CODES.RATE_LIMITED)
  }
  if (status === 400 || status === 422) {
    return new WebError(`Decodo rejected the fetch of ${url} (HTTP ${status})${suffix}`, CODES.INVALID_REQUEST)
  }
  return new WebError(`Decodo could not fetch ${url} (HTTP ${status})${suffix}`, CODES.SCRAPE_FAILED)
}

function apiMessage(payload: ApiPayload | undefined): string {
  let candidate = ''
  if (typeof payload?.message === 'string') candidate = payload.message
  else if (typeof payload?.raw === 'string') candidate = payload.raw
  else if (Array.isArray(payload?.errors)) {
    candidate = payload.errors
      .map((e: unknown) => (typeof e === 'string' ? e : (e as { message?: unknown })?.message))
      .filter((m): m is string => typeof m === 'string' && m !== '')
      .join('; ')
  }
  return candidate.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function describe(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined
  const code = e?.cause?.code ?? e?.code
  const message = typeof e?.message === 'string' ? e.message : String(error)
  return typeof code === 'string' ? `${message} (${code})` : message
}

function isFailedEnvelope(value: unknown): value is { status: 'failed'; message?: unknown } {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'failed'
}

function toFetchResult({ payload, url, cfg }: { payload: ApiPayload | undefined; url: string; cfg: Config }): WebFetchResult {
  if (isFailedEnvelope(payload)) {
    const detail = apiMessage(payload)
    throw new WebError(`Decodo could not fetch ${url}${detail ? `: ${detail}` : ''}`, CODES.SCRAPE_FAILED)
  }
  const entry = Array.isArray(payload?.results) ? (payload.results[0] as ScrapeResult | undefined) : undefined
  if (!entry || typeof entry !== 'object') {
    throw new WebError(`Decodo returned no result for ${url}`, CODES.BAD_RESPONSE)
  }
  if (isFailedEnvelope(entry.content)) {
    const detail = apiMessage(entry.content as ApiPayload)
    throw new WebError(`Decodo could not fetch ${url}${detail ? `: ${detail}` : ''}`, CODES.SCRAPE_FAILED)
  }

  let content: string
  if (entry.content === undefined || entry.content === null) content = ''
  else if (typeof entry.content === 'string') content = entry.content
  else content = JSON.stringify(entry.content)

  const truncated = content.length > cfg.maxContentChars
  if (truncated) content = content.slice(0, cfg.maxContentChars)

  const kind = bodyKind({ entry, content, cfg })
  const statusCode = Number.isInteger(entry.status_code) ? (entry.status_code as number) : 200
  const finalUrl = typeof entry.url === 'string' && entry.url !== '' ? entry.url : url
  const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

  return { url: finalUrl, statusCode, body, truncated }
}

function bodyKind({ entry, content, cfg }: { entry: ScrapeResult; content: string; cfg: Config }): WebFetchBody['kind'] {
  if (cfg.output === 'html') return 'html'
  if (typeof entry.help === 'string' && entry.help !== '') return 'html'
  if (looksLikeHtml(content)) return 'html'
  return 'text'
}

export function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 512).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}
