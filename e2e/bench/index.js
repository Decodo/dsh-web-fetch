import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

export const name = 'e2e-bench'
export const inject = ['web']

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 60000)
const MAX_OUTPUT_CHARS = Number(process.env.E2E_MAX_OUTPUT_CHARS ?? 200000)
const DIRECT_OK_WINDOW_MS = 20000
const ORDER = process.env.E2E_ORDER ?? 'direct-first'

export function apply(ctx) {
  run(ctx)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('e2e-bench failed:', error)
      process.exit(2)
    })
}

async function run(ctx) {
  const mode = process.env.E2E_MODE ?? 'bench'
  const out = process.env.E2E_OUT
  const { formatFetchOutput } = await loadToolWeb()

  if (mode === 'missing-token') {
    const url = process.env.E2E_URL ?? 'https://example.com/'
    const record = await viaDsh(ctx, url, formatFetchOutput)
    const result = { mode, url, tokenEnvSet: Boolean(process.env.SCRAPER_API_TOKEN), dsh: record }
    console.log(JSON.stringify(result, null, 2))
    if (out) writeFileSync(out, JSON.stringify(result, null, 2))
    return 0
  }

  const urls = JSON.parse(readFileSync(process.env.E2E_URLS, 'utf8'))
  const rows = []
  for (const group of ['protected', 'plain']) {
    for (const url of urls[group]) {
      let direct, dsh
      if (ORDER === 'dsh-first') {
        dsh = await viaDsh(ctx, url, formatFetchOutput)
        direct = await viaDirect(url)
      } else {
        direct = await viaDirect(url)
        dsh = await viaDsh(ctx, url, formatFetchOutput)
      }
      const row = { group, url, direct, dsh }
      rows.push(row)
      console.error(`${group.padEnd(9)} ${fmt(direct)} | dsh ${fmt(dsh)}  ${url}`)
    }
  }
  const summary = summarize(rows)
  const result = { generatedAt: new Date().toISOString(), timeoutMs: TIMEOUT_MS, order: ORDER, rows, summary }
  if (out) writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  return 0
}

function fmt(r) {
  return `${r.ok ? 'ok ' : 'ERR'} ${String(r.ms).padStart(6)}ms http=${r.statusCode ?? '-'} ${r.code ?? ''}`.trim()
}

async function viaDirect(url) {
  const t0 = performance.now()
  try {
    const res = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        authorization: `Basic ${process.env.SCRAPER_API_TOKEN}`,
        'content-type': 'application/json',
        'x-integration': 'dsh',
      },
      body: JSON.stringify({ url, markdown: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const ms = Math.round(performance.now() - t0)
    const json = await res.json().catch(() => undefined)
    const entry = json?.results?.[0]
    const content = typeof entry?.content === 'string' ? entry.content : ''
    const statusCode = entry?.status_code
    const ok = res.ok && statusCode < 400 && content.trim().length > 0
    return { ok, ms, httpStatus: res.status, statusCode, chars: content.length, fallback: typeof entry?.help === 'string', ...(ok ? {} : { code: `HTTP_${res.status}`, message: json?.message }) }
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - t0), code: error?.name ?? 'ERROR', message: String(error?.message ?? error) }
  }
}

async function viaDsh(ctx, url, formatFetchOutput) {
  const t0 = performance.now()
  try {
    const result = await ctx.web.fetch({ url }, AbortSignal.timeout(TIMEOUT_MS))
    const text = formatFetchOutput(result, MAX_OUTPUT_CHARS)
    const ms = Math.round(performance.now() - t0)
    const body = result.body.content
    const ok = result.statusCode < 400 && body.trim().length > 0
    return { ok, ms, statusCode: result.statusCode, kind: result.body.kind, chars: body.length, renderedChars: text.length, truncated: result.truncated, head: text.slice(0, 160) }
  } catch (error) {
    const ms = Math.round(performance.now() - t0)
    const timedOut = error?.code === 'WEB_FETCH_TIMEOUT' || error?.cause?.name === 'TimeoutError'
    return { ok: false, ms, code: error?.code ?? error?.name ?? 'ERROR', message: String(error?.message ?? error), timedOut }
  }
}

function summarize(rows) {
  const groups = {}
  for (const group of ['protected', 'plain', 'all']) {
    const set = rows.filter((r) => group === 'all' || r.group === group)
    const directOk = set.filter((r) => r.direct.ok)
    const bothOk = directOk.filter((r) => r.dsh.ok)
    const added = directOk.map((r) => r.dsh.ms - r.direct.ms)
    const directWithin20s = set.filter((r) => r.direct.ok && r.direct.ms <= DIRECT_OK_WINDOW_MS)
    const dshTimeoutsWhereDirectFast = directWithin20s.filter((r) => r.dsh.timedOut).length
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
      dshTimeoutsWhereDirectUnder20s: dshTimeoutsWhereDirectFast,
      markdownFallbacks: set.filter((r) => r.direct.fallback).length,
    }
  }
  const a = groups.all
  groups.gates = {
    successRateVsDirect: { value: a.successRateVsDirect, pass: a.successRateVsDirect !== null && a.successRateVsDirect >= 0.9 },
    addedLatencyMedianMs: { value: a.addedLatencyMedianMs, pass: a.addedLatencyMedianMs !== null && a.addedLatencyMedianMs <= 1000 },
    timeoutsWhereDirectUnder20s: { value: a.dshTimeoutsWhereDirectUnder20s, pass: a.dshTimeoutsWhereDirectUnder20s === 0 },
  }
  return groups
}

function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function round(x) {
  return Math.round(x * 1000) / 1000
}

async function loadToolWeb() {
  const dshPkg = process.env.E2E_DSH_PKG
  const fromDsh = createRequire(dshPkg)
  const basePkg = fromDsh.resolve('@deepseek-ai/dsh-base/package.json')
  const fromBase = createRequire(basePkg)
  const toolWeb = fromBase.resolve('@deepseek-ai/dsh-tool-web')
  return import(toolWeb)
}
