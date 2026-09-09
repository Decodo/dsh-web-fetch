import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'
import { CODES, INTEGRATION, PROVIDER_ID, createDecodoFetchProvider, resolveConfig } from '../src/provider.ts'
import type { Config } from '../src/provider.ts'

const TOKEN = 'dGVzdDp0ZXN0'

interface RecordedCall {
  url: string
  init: RequestInit & { headers: Record<string, string>; body: string }
  body: { url: string; markdown: boolean }
}

function apiResponse(body: unknown, { status = 200 }: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function okPayload(overrides: Record<string, unknown> = {}) {
  return { results: [{ content: '# Hello\n\nworld', status_code: 200, task_id: '1', ...overrides }] }
}

function makeProvider({
  reply = () => apiResponse(okPayload()),
  env = { SCRAPER_API_TOKEN: TOKEN },
  config = {},
}: {
  reply?: (callNumber: number) => Response
  env?: Record<string, string>
  config?: Partial<Config>
} = {}): { provider: WebFetchProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const provider = createDecodoFetchProvider(config, {
    env,
    fetch: async (url, init) => {
      const recorded = init as RecordedCall['init']
      calls.push({ url: String(url), init: recorded, body: JSON.parse(recorded.body) })
      return reply(calls.length)
    },
  })
  return { provider, calls }
}

function lastCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.at(-1)
  assert.ok(call, 'expected at least one recorded call')
  return call
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebError, `expected WebError, got ${String(error)}`)
    assert.equal(error.code, code, `expected code ${code}, got ${error.code} (${error.message})`)
    return true
  })
}

test('id and available(): env presence only', () => {
  assert.equal(makeProvider().provider.id, PROVIDER_ID)
  assert.equal(makeProvider().provider.available(), true)
  assert.equal(makeProvider({ env: {} }).provider.available(), false)
  assert.equal(makeProvider({ env: { SCRAPER_API_TOKEN: '   ' } }).provider.available(), false)
  assert.equal(makeProvider({ env: { MY_TOKEN: TOKEN }, config: { tokenEnv: 'MY_TOKEN' } }).provider.available(), true)
})

test('request shape: POST /v2/scrape with Basic auth, markdown flag and the integration header', async () => {
  const { provider, calls } = makeProvider()
  await provider.fetch({ url: 'https://example.com/' })
  assert.equal(calls.length, 1)
  const call = lastCall(calls)
  assert.equal(call.url, 'https://scraper-api.decodo.com/v2/scrape')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, `Basic ${TOKEN}`)
  assert.equal(call.init.headers['x-integration'], INTEGRATION)
  assert.deepEqual(call.body, { url: 'https://example.com/', markdown: true })
})

test('markdown output comes back as kind text with the upstream status and url', async () => {
  const { provider } = makeProvider({ reply: () => apiResponse(okPayload({ url: 'https://example.com/final' })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.deepEqual(result, {
    url: 'https://example.com/final',
    statusCode: 200,
    body: { kind: 'text', content: '# Hello\n\nworld' },
    truncated: false,
  })
})

test('final url falls back to the request url when the API omits it', async () => {
  const { provider } = makeProvider()
  const result = await provider.fetch({ url: 'https://example.com/page' })
  assert.equal(result.url, 'https://example.com/page')
})

test('markdown fallback (help present) is returned as kind html so dsh converts it', async () => {
  const html = '<!doctype html><html><body><h1>x</h1></body></html>'
  const { provider } = makeProvider({ reply: () => apiResponse(okPayload({ content: html, help: 'We could not convert this response to markdown, so it is returned as raw HTML.' })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.equal(result.body.kind, 'html')
  assert.equal(result.body.content, html)
})

test('an HTML document without help is still classified as html', async () => {
  const { provider } = makeProvider({ reply: () => apiResponse(okPayload({ content: '\n  <HTML><body>raw</body></HTML>' })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.equal(result.body.kind, 'html')
})

test('output: html requests raw HTML and returns kind html', async () => {
  const { provider, calls } = makeProvider({ config: { output: 'html' }, reply: () => apiResponse(okPayload({ content: '<div>partial</div>' })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.deepEqual(lastCall(calls).body, { url: 'https://example.com/', markdown: false })
  assert.equal(result.body.kind, 'html')
})

test('non-string content (parsed JSON) is serialized as text', async () => {
  const { provider } = makeProvider({ reply: () => apiResponse(okPayload({ content: { a: 1 } })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.deepEqual(result.body, { kind: 'text', content: '{"a":1}' })
})

test('a non-2xx upstream page is a result, not an error', async () => {
  const { provider } = makeProvider({ reply: () => apiResponse(okPayload({ content: 'Not found', status_code: 404 })) })
  const result = await provider.fetch({ url: 'https://example.com/missing' })
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'Not found')
})

test('body is capped at maxContentChars and flagged truncated', async () => {
  const { provider } = makeProvider({ config: { maxContentChars: 5 }, reply: () => apiResponse(okPayload({ content: '0123456789' })) })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, '01234')
  assert.equal(result.truncated, true)
})

test('missing token: clear error, no request made', async () => {
  const { provider, calls } = makeProvider({ env: {} })
  await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.TOKEN_MISSING)
  assert.equal(calls.length, 0)
})

test('spend cap: the (n+1)th fetch fails with a clear error and does not call the API', async () => {
  const { provider, calls } = makeProvider({ config: { maxFetchesPerSession: 2 } })
  await provider.fetch({ url: 'https://example.com/1' })
  await provider.fetch({ url: 'https://example.com/2' })
  await rejectsWith(provider.fetch({ url: 'https://example.com/3' }), CODES.CAP_REACHED)
  assert.equal(calls.length, 2)
})

test('spend cap counts attempts, including failed ones', async () => {
  const { provider, calls } = makeProvider({ config: { maxFetchesPerSession: 1 }, reply: () => apiResponse({ status: 'error', message: 'boom' }, { status: 500 }) })
  await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.SCRAPE_FAILED)
  await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.CAP_REACHED)
  assert.equal(calls.length, 1)
})

test('spend cap 0 disables the cap', async () => {
  const { provider, calls } = makeProvider({ config: { maxFetchesPerSession: 0 } })
  for (let i = 0; i < 5; i += 1) await provider.fetch({ url: 'https://example.com/' })
  assert.equal(calls.length, 5)
})

test('invalid urls are rejected before any request', async () => {
  const { provider, calls } = makeProvider()
  await rejectsWith(provider.fetch({ url: '' }), 'WEB_INVALID_URL')
  await rejectsWith(provider.fetch({ url: 'notaurl' }), 'WEB_INVALID_URL')
  await rejectsWith(provider.fetch({ url: 'ftp://example.com/' }), 'WEB_INVALID_URL')
  await rejectsWith(provider.fetch({} as { url: string }), 'WEB_INVALID_URL')
  assert.equal(calls.length, 0)
})

test('API error statuses map to codes with a model-safe message', async () => {
  const cases: Array<[number, unknown, string, RegExp]> = [
    [401, { status: 'failed', message: 'Incorrect username or password' }, CODES.AUTH_FAILED, /authentication failed .*Incorrect username/i],
    [403, { message: 'forbidden' }, CODES.AUTH_FAILED, /HTTP 403/],
    [429, { message: 'Too many requests' }, CODES.RATE_LIMITED, /rate limit/i],
    [400, { status: 'error', message: 'Invalid URL format' }, CODES.INVALID_REQUEST, /Invalid URL format/],
    [422, { message: 'Faulted scraping the url, please try again' }, CODES.INVALID_REQUEST, /Faulted/],
    [500, 'Internal Server Error', CODES.SCRAPE_FAILED, /HTTP 500.*Internal Server Error/],
    [503, '', CODES.SCRAPE_FAILED, /HTTP 503/],
  ]
  for (const [status, body, code, pattern] of cases) {
    const { provider } = makeProvider({ reply: () => apiResponse(body, { status }) })
    await assert.rejects(provider.fetch({ url: 'https://example.com/' }), (error: unknown) => {
      assert.ok(error instanceof WebError)
      assert.equal(error.code, code, `status ${status}`)
      assert.match(error.message, pattern)
      assert.doesNotMatch(error.message, /\n/)
      return true
    })
  }
})

test('error messages from the API are single-line and capped', async () => {
  const { provider } = makeProvider({ reply: () => apiResponse({ message: `a\n${'b'.repeat(1000)}` }, { status: 500 }) })
  await assert.rejects(provider.fetch({ url: 'https://example.com/' }), (error: unknown) => {
    assert.ok(error instanceof WebError)
    assert.ok(error.message.length < 400)
    assert.doesNotMatch(error.message, /\n/)
    return true
  })
})

test('a failed scrape envelope inside a 200 is a scrape error', async () => {
  for (const body of [
    { status: 'failed', message: 'blocked' },
    { results: [{ content: { status: 'failed', message: 'blocked' }, status_code: 200 }] },
  ]) {
    const { provider } = makeProvider({ reply: () => apiResponse(body) })
    await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.SCRAPE_FAILED)
  }
})

test('malformed 200 bodies are a bad-response error', async () => {
  for (const body of ['', 'not json', {}, { results: [] }, { results: 'x' }]) {
    const { provider } = makeProvider({ reply: () => apiResponse(body) })
    await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.BAD_RESPONSE)
  }
})

test('transport failures become WEB_PROVIDER_ERROR', async () => {
  const provider = createDecodoFetchProvider({}, {
    env: { SCRAPER_API_TOKEN: TOKEN },
    fetch: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) },
  })
  await assert.rejects(provider.fetch({ url: 'https://example.com/' }), (error: unknown) => {
    assert.ok(error instanceof WebError)
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /ENOTFOUND/)
    return true
  })
})

function neverResolvingFetch(onAbort?: () => void): typeof fetch {
  return (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal
    assert.ok(signal, 'expected a signal')
    signal.addEventListener('abort', () => reject(signal.reason))
    onAbort?.()
  })
}

test('an already-aborted signal short-circuits; abort during the request maps to WEB_ABORTED; timeout maps to WEB_FETCH_TIMEOUT', async () => {
  const pre = new AbortController()
  pre.abort()
  const { provider: preAborted, calls } = makeProvider()
  await rejectsWith(preAborted.fetch({ url: 'https://example.com/' }, pre.signal), 'WEB_ABORTED')
  assert.equal(calls.length, 0)

  const during = new AbortController()
  const abortedMidFlight = createDecodoFetchProvider({}, {
    env: { SCRAPER_API_TOKEN: TOKEN },
    fetch: neverResolvingFetch(() => during.abort()),
  })
  await rejectsWith(abortedMidFlight.fetch({ url: 'https://example.com/' }, during.signal), 'WEB_ABORTED')

  const timedOut = createDecodoFetchProvider({}, {
    env: { SCRAPER_API_TOKEN: TOKEN },
    fetch: neverResolvingFetch(),
  })
  await rejectsWith(timedOut.fetch({ url: 'https://example.com/' }, AbortSignal.timeout(10)), 'WEB_FETCH_TIMEOUT')
})

test('the signal is forwarded to fetch()', async () => {
  const controller = new AbortController()
  const { provider, calls } = makeProvider()
  await provider.fetch({ url: 'https://example.com/' }, controller.signal)
  assert.equal(lastCall(calls).init.signal, controller.signal)
})

test('resolveConfig validates and normalizes', () => {
  assert.equal(resolveConfig({ baseUrl: 'https://api.test/' }).baseUrl, 'https://api.test')
  assert.equal(resolveConfig({}).output, 'markdown')
  assert.throws(() => resolveConfig({ output: 'pdf' as Config['output'] }), /output must be one of/)
  assert.throws(() => resolveConfig({ tokenEnv: '' }), /tokenEnv/)
  assert.throws(() => resolveConfig({ baseUrl: 'ftp://x' }), /baseUrl/)
  assert.throws(() => resolveConfig({ maxFetchesPerSession: -1 }), /maxFetchesPerSession/)
  assert.throws(() => resolveConfig({ maxFetchesPerSession: 1.5 }), /maxFetchesPerSession/)
  assert.throws(() => resolveConfig({ maxContentChars: 0 }), /maxContentChars/)
})
