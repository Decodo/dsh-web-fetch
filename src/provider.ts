import {
  AuthenticationError,
  DecodoClient,
  DecodoError,
  RateLimitError,
  Target,
  TimeoutError,
  ValidationError,
} from '@decodo/sdk-ts'
import type { ResultEntry, SyncResponse } from '@decodo/sdk-ts'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'

export const PROVIDER_ID = 'decodo'
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
  output: Output
  maxFetchesPerSession: number
  maxContentChars: number
  requestTimeoutMs: number
}

export interface Deps {
  env?: Record<string, string | undefined>
}

export function defaultConfig(): Config {
  return {
    tokenEnv: DEFAULT_TOKEN_ENV,
    output: 'markdown',
    maxFetchesPerSession: 200,
    maxContentChars: 200_000,
    requestTimeoutMs: 60_000,
  }
}

export function resolveConfig(config: Partial<Config> | undefined): Config {
  const cfg: Config = { ...defaultConfig(), ...(config ?? {}) }
  if (typeof cfg.tokenEnv !== 'string' || cfg.tokenEnv.trim() === '') {
    throw new TypeError('web-fetch-decodo: tokenEnv must be a non-empty string')
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
  if (!Number.isInteger(cfg.requestTimeoutMs) || cfg.requestTimeoutMs < 1) {
    throw new TypeError('web-fetch-decodo: requestTimeoutMs must be a positive integer')
  }
  return cfg
}

export function createDecodoFetchProvider(config: Partial<Config> | undefined, deps: Deps = {}): WebFetchProvider {
  const cfg = resolveConfig(config)
  const env = deps.env ?? process.env
  let fetches = 0
  let client: { token: string; api: DecodoClient['webScrapingApi'] } | undefined

  const readToken = (): string | undefined => {
    const value = env[cfg.tokenEnv]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  const apiFor = (token: string): DecodoClient['webScrapingApi'] => {
    if (client?.token !== token) {
      client = {
        token,
        api: new DecodoClient({
          webScrapingApi: { token, integrationHeader: INTEGRATION },
          timeoutMs: cfg.requestTimeoutMs,
        }).webScrapingApi,
      }
    }
    return client.api
  }

  return {
    id: PROVIDER_ID,
    available: () => readToken() !== undefined,
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

      const scrape = apiFor(token).scrape({ target: Target.Universal, url, markdown: cfg.output === 'markdown' })
      const response = await untilAborted(scrape, signal).catch((error: unknown) => {
        throw mapSdkError(error, url)
      })
      return toFetchResult({ response, url, cfg })
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

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function mapSdkError(error: unknown, url: string): WebError {
  if (error instanceof WebError) return error
  if (error instanceof AuthenticationError) {
    return new WebError(`Decodo authentication failed: ${singleLine(error.message)}. Check the Web Scraping API token`, CODES.AUTH_FAILED, { cause: error })
  }
  if (error instanceof RateLimitError) {
    return new WebError(`Decodo rate limit reached (HTTP 429): ${singleLine(error.message)}. Retry later`, CODES.RATE_LIMITED, { cause: error })
  }
  if (error instanceof ValidationError) {
    return new WebError(`Decodo rejected the fetch of ${url}: ${singleLine(error.message)}`, CODES.INVALID_REQUEST, { cause: error })
  }
  if (error instanceof TimeoutError) {
    return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  }
  if (error instanceof DecodoError && (error.statusCode === 400 || error.statusCode === 422)) {
    return new WebError(`Decodo rejected the fetch of ${url} (HTTP ${error.statusCode}): ${singleLine(error.message)}`, CODES.INVALID_REQUEST, { cause: error })
  }
  if (error instanceof DecodoError) {
    return new WebError(`Decodo could not fetch ${url} (HTTP ${error.statusCode}): ${singleLine(error.message)}`, CODES.SCRAPE_FAILED, { cause: error })
  }
  if (error instanceof SyntaxError) {
    return new WebError(`Decodo returned an unreadable response for ${url}`, CODES.BAD_RESPONSE, { cause: error })
  }
  return new WebError(`could not reach the Decodo API: ${describeTransportError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

function singleLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function describeTransportError(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined
  const code = e?.cause?.code ?? e?.code
  const message = typeof e?.message === 'string' ? e.message : String(error)
  return typeof code === 'string' ? `${message} (${code})` : message
}

function isFailedEnvelope(value: unknown): value is { status: 'failed'; message?: unknown } {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'failed'
}

function throwIfScrapeFailed(value: unknown, url: string): void {
  if (!isFailedEnvelope(value)) return
  const detail = typeof value.message === 'string' ? singleLine(value.message) : ''
  throw new WebError(`Decodo could not fetch ${url}${detail ? `: ${detail}` : ''}`, CODES.SCRAPE_FAILED)
}

function toFetchResult({ response, url, cfg }: { response: SyncResponse | undefined; url: string; cfg: Config }): WebFetchResult {
  throwIfScrapeFailed(response, url)
  const entry: ResultEntry | undefined = Array.isArray(response?.results) ? response.results[0] : undefined
  if (!entry || typeof entry !== 'object') {
    throw new WebError(`Decodo returned no result for ${url}`, CODES.BAD_RESPONSE)
  }
  throwIfScrapeFailed(entry.content, url)

  let content: string
  if (entry.content === undefined || entry.content === null) content = ''
  else if (typeof entry.content === 'string') content = entry.content
  else content = JSON.stringify(entry.content)

  const truncated = content.length > cfg.maxContentChars
  if (truncated) content = content.slice(0, cfg.maxContentChars)

  const kind = bodyKind({ entry, content, cfg })
  const statusCode = Number.isInteger(entry.status_code) ? entry.status_code : 200
  const finalUrl = typeof entry.url === 'string' && entry.url !== '' ? entry.url : url
  const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

  return { url: finalUrl, statusCode, body, truncated }
}

function bodyKind({ entry, content, cfg }: { entry: ResultEntry; content: string; cfg: Config }): WebFetchBody['kind'] {
  if (cfg.output === 'html') return 'html'
  if (typeof entry.help === 'string' && entry.help !== '') return 'html'
  if (looksLikeHtml(content)) return 'html'
  return 'text'
}

export function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 512).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}
