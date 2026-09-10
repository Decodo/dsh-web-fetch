import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'

export const name = 'e2e-bench'
export const inject = ['web']

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 60000)
const MAX_OUTPUT_CHARS = Number(process.env.E2E_MAX_OUTPUT_CHARS ?? 200000)
const DIRECT_OK_WINDOW_MS = 20000
const REGISTRATION_WAIT_MS = 15000
const ORDER = process.env.E2E_ORDER ?? 'direct-first'

type FormatFetchOutput = (result: WebFetchResult, maxOutputChars: number) => string
type Group = 'protected' | 'plain'

interface DirectRecord {
  ok: boolean
  ms: number
  httpStatus?: number
  statusCode?: number
  chars?: number
  fallback?: boolean
  code?: string
  message?: string
}

interface DshRecord {
  ok: boolean
  ms: number
  statusCode?: number
  kind?: string
  chars?: number
  renderedChars?: number
  truncated?: boolean
  head?: string
  code?: string
  message?: string
  timedOut?: boolean
}

interface Row {
  group: Group
  url: string
  direct: DirectRecord
  dsh: DshRecord
}

interface ScrapeEnvelope {
  results?: Array<{ content?: unknown; status_code?: number; help?: unknown }>
  message?: string
}

export function apply(ctx: Context): void {
  run(ctx)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error('e2e-bench failed:', error)
      process.exit(2)
    })
}

async function run(ctx: Context): Promise<number> {
  const mode = process.env.E2E_MODE ?? 'bench'
  const out = process.env.E2E_OUT
  const { formatFetchOutput } = await loadToolWeb()

  if (mode === 'missing-token') {
    const url = process.env.E2E_URL ?? 'https://example.com/'
    const record = await viaDsh(ctx, url, formatFetchOutput)
    const result = { mode, url, credentialSet: Boolean(process.env.DECODO_API_KEY || process.env.SCRAPER_API_TOKEN), dsh: record }
    console.log(JSON.stringify(result, null, 2))
    if (out) writeFileSync(out, JSON.stringify(result, null, 2))
    return 0
  }

  const urlsFile = process.env.E2E_URLS
  if (!urlsFile) throw new Error('E2E_URLS must point at the URL set')
  const urls = JSON.parse(readFileSync(urlsFile, 'utf8')) as Record<Group, string[]>
  const rows: Row[] = []
  for (const group of ['protected', 'plain'] as const) {
    for (const url of urls[group]) {
      let direct: DirectRecord
      let dsh: DshRecord
      if (ORDER === 'dsh-first') {
        dsh = await viaDsh(ctx, url, formatFetchOutput)
        direct = await viaDirect(url)
      } else {
        direct = await viaDirect(url)
        dsh = await viaDsh(ctx, url, formatFetchOutput)
      }
      rows.push({ group, url, direct, dsh })
      console.error(`${group.padEnd(9)} ${fmt(direct)} | dsh ${fmt(dsh)}  ${url}`)
    }
  }
  const summary = summarize(rows)
  const result = { generatedAt: new Date().toISOString(), timeoutMs: TIMEOUT_MS, order: ORDER, rows, summary }
  if (out) writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  return 0
}

function fmt(r: DirectRecord | DshRecord): string {
  return `${r.ok ? 'ok ' : 'ERR'} ${String(r.ms).padStart(6)}ms http=${r.statusCode ?? '-'} ${r.code ?? ''}`.trim()
}

async function viaDirect(url: string): Promise<DirectRecord> {
  const t0 = performance.now()
  try {
    const res = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        authorization: `Basic ${process.env.SCRAPER_API_TOKEN ?? ''}`,
        'content-type': 'application/json',
        'x-integration': 'dsh',
      },
      body: JSON.stringify({ url, markdown: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const ms = Math.round(performance.now() - t0)
    const json = (await res.json().catch(() => undefined)) as ScrapeEnvelope | undefined
    const entry = json?.results?.[0]
    const content = typeof entry?.content === 'string' ? entry.content : ''
    const statusCode = entry?.status_code
    const ok = res.ok && typeof statusCode === 'number' && statusCode < 400 && content.trim().length > 0
    const record: DirectRecord = { ok, ms, httpStatus: res.status, statusCode, chars: content.length, fallback: typeof entry?.help === 'string' }
    if (!ok) {
      record.code = `HTTP_${res.status}`
      record.message = json?.message
    }
    return record
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - t0), code: errorName(error), message: errorMessage(error) }
  }
}

async function fetchOnceRegistered(ctx: Context, url: string): Promise<WebFetchResult> {
  const deadline = Date.now() + REGISTRATION_WAIT_MS
  for (;;) {
    try {
      return await ctx.web.fetch({ url }, AbortSignal.timeout(TIMEOUT_MS))
    } catch (error) {
      if (errorCode(error) !== 'WEB_PROVIDER_CONFIGURED_MISSING' || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function viaDsh(ctx: Context, url: string, formatFetchOutput: FormatFetchOutput): Promise<DshRecord> {
  const t0 = performance.now()
  try {
    const result = await fetchOnceRegistered(ctx, url)
    const text = formatFetchOutput(result, MAX_OUTPUT_CHARS)
    const ms = Math.round(performance.now() - t0)
    const body = result.body.content
    const ok = result.statusCode < 400 && body.trim().length > 0
    return { ok, ms, statusCode: result.statusCode, kind: result.body.kind, chars: body.length, renderedChars: text.length, truncated: result.truncated, head: text.slice(0, 160) }
  } catch (error) {
    const ms = Math.round(performance.now() - t0)
    const timedOut = errorCode(error) === 'WEB_FETCH_TIMEOUT' || causeName(error) === 'TimeoutError'
    return { ok: false, ms, code: errorCode(error) ?? errorName(error), message: errorMessage(error), timedOut }
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | undefined)?.name
  return typeof name === 'string' ? name : 'ERROR'
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

function causeName(error: unknown): string | undefined {
  const cause = (error as { cause?: { name?: unknown } } | undefined)?.cause
  return typeof cause?.name === 'string' ? cause.name : undefined
}

interface GroupSummary {
  urls: number
  directOk: number
  dshOk: number
  dshOkWhereDirectOk: number
  successRateVsDirect: number | null
  directP50Ms: number | null
  directP95Ms: number | null
  dshP50Ms: number | null
  dshP95Ms: number | null
  addedLatencyMedianMs: number | null
  addedLatencyP95Ms: number | null
  dshTimeouts: number
  dshTimeoutsWhereDirectUnder20s: number
  markdownFallbacks: number
}

interface Gate {
  value: number | null
  pass: boolean
}

function summarize(rows: Row[]) {
  const groups = {} as Record<Group | 'all', GroupSummary>
  for (const group of ['protected', 'plain', 'all'] as const) {
    const set = rows.filter((r) => group === 'all' || r.group === group)
    const directOk = set.filter((r) => r.direct.ok)
    const bothOk = directOk.filter((r) => r.dsh.ok)
    const added = directOk.map((r) => r.dsh.ms - r.direct.ms)
    const directWithin20s = set.filter((r) => r.direct.ok && r.direct.ms <= DIRECT_OK_WINDOW_MS)
    groups[group] = {
      urls: set.length,
      directOk: directOk.length,
      dshOk: set.filter((r) => r.dsh.ok).length,
      dshOkWhereDirectOk: bothOk.length,
      successRateVsDirect: directOk.length ? round(bothOk.length / directOk.length) : null,
      directP50Ms: pct(set.map((r) => r.direct.ms), 0.5),
      directP95Ms: pct(set.map((r) => r.direct.ms), 0.95),
      dshP50Ms: pct(set.map((r) => r.dsh.ms), 0.5),
      dshP95Ms: pct(set.map((r) => r.dsh.ms), 0.95),
      addedLatencyMedianMs: pct(added, 0.5),
      addedLatencyP95Ms: pct(added, 0.95),
      dshTimeouts: set.filter((r) => r.dsh.timedOut).length,
      dshTimeoutsWhereDirectUnder20s: directWithin20s.filter((r) => r.dsh.timedOut).length,
      markdownFallbacks: set.filter((r) => r.direct.fallback).length,
    }
  }
  const a = groups.all
  const gates: Record<string, Gate> = {
    successRateVsDirect: { value: a.successRateVsDirect, pass: a.successRateVsDirect !== null && a.successRateVsDirect >= 0.9 },
    addedLatencyMedianMs: { value: a.addedLatencyMedianMs, pass: a.addedLatencyMedianMs !== null && a.addedLatencyMedianMs <= 1000 },
    timeoutsWhereDirectUnder20s: { value: a.dshTimeoutsWhereDirectUnder20s, pass: a.dshTimeoutsWhereDirectUnder20s === 0 },
  }
  return { ...groups, gates }
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? null
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}

async function loadToolWeb(): Promise<{ formatFetchOutput: FormatFetchOutput }> {
  const dshPkg = process.env.E2E_DSH_PKG
  if (!dshPkg) throw new Error('E2E_DSH_PKG must point at the dsh package.json')
  const fromDsh = createRequire(dshPkg)
  const basePkg = fromDsh.resolve('@deepseek-ai/dsh-base/package.json')
  const fromBase = createRequire(basePkg)
  const toolWeb = fromBase.resolve('@deepseek-ai/dsh-tool-web')
  return import(toolWeb) as Promise<{ formatFetchOutput: FormatFetchOutput }>
}
