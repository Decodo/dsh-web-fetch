import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'
import { CODES, INTEGRATION, PROVIDER_ID, createDecodoFetchProvider, resolveConfig } from '../src/provider.ts'
import type { Config } from '../src/provider.ts'

const TOKEN = 'dGVzdDp0ZXN0'
const SCRAPE_URL = 'https://scraper-api.decodo.com/v2/scrape'

interface RecordedCall {
  url: string
  headers: Record<string, string>
  body: { target: string; url: string; markdown: boolean }
  signal: AbortSignal | undefined
}

type FetchHandler = (call: RecordedCall, init: RequestInit) => Response | Promise<Response>

function apiResponse(body: unknown, { status = 200 }: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function okPayload(overrides: Record<string, unknown> = {}) {
  return { results: [{ content: '# Hello\n\nworld', status_code: 200, task_id: '1', ...overrides }] }
}

async function withFetch<T>(handler: FetchHandler, run: (calls: RecordedCall[]) => Promise<T>): Promise<T> {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return handler(call, init ?? {})
  }) as typeof fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

function makeProvider({ env = { SCRAPER_API_TOKEN: TOKEN }, config = {} }: { env?: Record<string, string>; config?: Partial<Config> } = {}): WebFetchProvider {
  return createDecodoFetchProvider(config, { env })
}

const replyOk: FetchHandler = () => apiResponse(okPayload())

function hanging(): FetchHandler {
  return () => new Promise(() => {})
}

function hangingUntilSdkAbort(): FetchHandler {
  return (_call, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<WebError> {
  let caught: WebError | undefined
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebError, `expected WebError, got ${String(error)}`)
    assert.equal(error.code, code, `expected code ${code}, got ${error.code} (${error.message})`)
    caught = error
    return true
  })
  assert.ok(caught)
  return caught
}

test('id and available(): env presence only', () => {
  assert.equal(makeProvider().id, PROVIDER_ID)
  assert.equal(makeProvider().available(), true)
  assert.equal(makeProvider({ env: {} }).available(), false)
  assert.equal(makeProvider({ env: { SCRAPER_API_TOKEN: '   ' } }).available(), false)
  assert.equal(makeProvider({ env: { MY_TOKEN: TOKEN }, config: { tokenEnv: 'MY_TOKEN' } }).available(), true)
})

test('request shape through the SDK: POST /v2/scrape, Basic auth, universal target, markdown flag, integration header', async () => {
  await withFetch(replyOk, async (calls) => {
    await makeProvider().fetch({ url: 'https://example.com/' })
    assert.equal(calls.length, 1)
    const call = calls[0]!
    assert.equal(call.url, SCRAPE_URL)
    assert.equal(call.headers.Authorization, `Basic ${TOKEN}`)
    assert.equal(call.headers['x-integration'], INTEGRATION)
    assert.deepEqual(call.body, { target: 'universal', url: 'https://example.com/', markdown: true })
  })
})

test('markdown output comes back as kind text with the upstream status and url', async () => {
  await withFetch(() => apiResponse(okPayload({ url: 'https://example.com/final' })), async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/' })
    assert.deepEqual(result, {
      url: 'https://example.com/final',
      statusCode: 200,
      body: { kind: 'text', content: '# Hello\n\nworld' },
      truncated: false,
    })
  })
})

test('final url falls back to the request url when the API omits it', async () => {
  await withFetch(replyOk, async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/page' })
    assert.equal(result.url, 'https://example.com/page')
  })
})

test('markdown fallback (help present) is returned as kind html so dsh converts it', async () => {
  const html = '<!doctype html><html><body><h1>x</h1></body></html>'
  await withFetch(() => apiResponse(okPayload({ content: html, help: 'We could not convert this response to markdown, so it is returned as raw HTML.' })), async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/' })
    assert.equal(result.body.kind, 'html')
    assert.equal(result.body.content, html)
  })
})

test('an HTML document without help is still classified as html', async () => {
  await withFetch(() => apiResponse(okPayload({ content: '\n  <HTML><body>raw</body></HTML>' })), async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/' })
    assert.equal(result.body.kind, 'html')
  })
})

test('output: html requests raw HTML and returns kind html', async () => {
  await withFetch(() => apiResponse(okPayload({ content: '<div>partial</div>' })), async (calls) => {
    const result = await makeProvider({ config: { output: 'html' } }).fetch({ url: 'https://example.com/' })
    assert.equal(calls[0]!.body.markdown, false)
    assert.equal(result.body.kind, 'html')
  })
})

test('non-string content (parsed JSON) is serialized as text', async () => {
  await withFetch(() => apiResponse(okPayload({ content: { a: 1 } })), async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/' })
    assert.deepEqual(result.body, { kind: 'text', content: '{"a":1}' })
  })
})

test('a non-2xx upstream page is a result, not an error', async () => {
  await withFetch(() => apiResponse(okPayload({ content: 'Not found', status_code: 404 })), async () => {
    const result = await makeProvider().fetch({ url: 'https://example.com/missing' })
    assert.equal(result.statusCode, 404)
    assert.equal(result.body.content, 'Not found')
  })
})

test('body is capped at maxContentChars and flagged truncated', async () => {
  await withFetch(() => apiResponse(okPayload({ content: '0123456789' })), async () => {
    const result = await makeProvider({ config: { maxContentChars: 5 } }).fetch({ url: 'https://example.com/' })
    assert.equal(result.body.content, '01234')
    assert.equal(result.truncated, true)
  })
})

test('missing token: clear error, no request made', async () => {
  await withFetch(replyOk, async (calls) => {
    await rejectsWith(makeProvider({ env: {} }).fetch({ url: 'https://example.com/' }), CODES.TOKEN_MISSING)
    assert.equal(calls.length, 0)
  })
})

test('spend cap: the (n+1)th fetch fails with a clear error and does not call the API', async () => {
  await withFetch(replyOk, async (calls) => {
    const provider = makeProvider({ config: { maxFetchesPerSession: 2 } })
    await provider.fetch({ url: 'https://example.com/1' })
    await provider.fetch({ url: 'https://example.com/2' })
    await rejectsWith(provider.fetch({ url: 'https://example.com/3' }), CODES.CAP_REACHED)
    assert.equal(calls.length, 2)
  })
})

test('spend cap counts attempts, including failed ones', async () => {
  await withFetch(() => apiResponse({ status: 'error', message: 'boom' }, { status: 500 }), async (calls) => {
    const provider = makeProvider({ config: { maxFetchesPerSession: 1 } })
    await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.SCRAPE_FAILED)
    await rejectsWith(provider.fetch({ url: 'https://example.com/' }), CODES.CAP_REACHED)
    assert.equal(calls.length, 1)
  })
})

test('spend cap 0 disables the cap', async () => {
  await withFetch(replyOk, async (calls) => {
    const provider = makeProvider({ config: { maxFetchesPerSession: 0 } })
    for (let i = 0; i < 5; i += 1) await provider.fetch({ url: 'https://example.com/' })
    assert.equal(calls.length, 5)
  })
})

test('invalid urls are rejected before any request', async () => {
  await withFetch(replyOk, async (calls) => {
    const provider = makeProvider()
    await rejectsWith(provider.fetch({ url: '' }), 'WEB_INVALID_URL')
    await rejectsWith(provider.fetch({ url: 'notaurl' }), 'WEB_INVALID_URL')
    await rejectsWith(provider.fetch({ url: 'ftp://example.com/' }), 'WEB_INVALID_URL')
    await rejectsWith(provider.fetch({} as { url: string }), 'WEB_INVALID_URL')
    assert.equal(calls.length, 0)
  })
})

test('SDK error classes map to codes with a model-safe message', async () => {
  const cases: Array<[number, unknown, string, RegExp]> = [
    [401, { status: 'failed', message: 'Incorrect username or password' }, CODES.AUTH_FAILED, /authentication failed: Incorrect username/],
    [403, { message: 'forbidden' }, CODES.AUTH_FAILED, /authentication failed: forbidden/],
    [429, { message: 'Too many requests' }, CODES.RATE_LIMITED, /rate limit/i],
    [400, { status: 'error', message: 'Invalid URL format' }, CODES.INVALID_REQUEST, /Invalid URL format/],
    [400, { message: 'bad', errors: [{ message: 'url is required' }] }, CODES.INVALID_REQUEST, /bad/],
    [422, { message: 'Faulted scraping the url, please try again' }, CODES.INVALID_REQUEST, /Faulted/],
    [500, 'Internal Server Error', CODES.SCRAPE_FAILED, /HTTP 500/],
    [503, '', CODES.SCRAPE_FAILED, /HTTP 503/],
  ]
  for (const [status, body, code, pattern] of cases) {
    await withFetch(() => apiResponse(body, { status }), async () => {
      const error = await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }), code)
      assert.match(error.message, pattern, `status ${status}`)
      assert.doesNotMatch(error.message, /\n/)
    })
  }
})

test('error messages from the API are single-line and capped', async () => {
  await withFetch(() => apiResponse({ message: `a\n${'b'.repeat(1000)}` }, { status: 500 }), async () => {
    const error = await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }), CODES.SCRAPE_FAILED)
    assert.ok(error.message.length < 400)
    assert.doesNotMatch(error.message, /\n/)
  })
})

test('a failed scrape envelope inside a 200 is a scrape error', async () => {
  for (const body of [
    { status: 'failed', message: 'blocked' },
    { results: [{ content: { status: 'failed', message: 'blocked' }, status_code: 200 }] },
  ]) {
    await withFetch(() => apiResponse(body), async () => {
      await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }), CODES.SCRAPE_FAILED)
    })
  }
})

test('malformed 200 bodies are a bad-response error', async () => {
  for (const body of ['', 'not json', {}, { results: [] }, { results: 'x' }]) {
    await withFetch(() => apiResponse(body), async () => {
      await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }), CODES.BAD_RESPONSE)
    })
  }
})

test('transport failures become WEB_PROVIDER_ERROR', async () => {
  await withFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }, async () => {
    const error = await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }), 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /ENOTFOUND/)
  })
})

test('an already-aborted dsh signal short-circuits before any request', async () => {
  await withFetch(replyOk, async (calls) => {
    const controller = new AbortController()
    controller.abort()
    await rejectsWith(makeProvider().fetch({ url: 'https://example.com/' }, controller.signal), 'WEB_ABORTED')
    assert.equal(calls.length, 0)
  })
})

test('a dsh abort while the SDK request is in flight rejects with WEB_ABORTED', async () => {
  await withFetch(hanging(), async () => {
    const controller = new AbortController()
    const pending = makeProvider({ config: { requestTimeoutMs: 50 } }).fetch({ url: 'https://example.com/' }, controller.signal)
    controller.abort()
    await rejectsWith(pending, 'WEB_ABORTED')
  })
})

test('a dsh timeout signal rejects with WEB_FETCH_TIMEOUT', async () => {
  await withFetch(hanging(), async () => {
    await rejectsWith(makeProvider({ config: { requestTimeoutMs: 50 } }).fetch({ url: 'https://example.com/' }, AbortSignal.timeout(10)), 'WEB_FETCH_TIMEOUT')
  })
})

test('the SDK request timeout (requestTimeoutMs) rejects with WEB_FETCH_TIMEOUT', async () => {
  await withFetch(hangingUntilSdkAbort(), async (calls) => {
    await rejectsWith(makeProvider({ config: { requestTimeoutMs: 10 } }).fetch({ url: 'https://example.com/' }), 'WEB_FETCH_TIMEOUT')
    assert.ok(calls[0]!.signal?.aborted)
  })
})

test('resolveConfig validates and normalizes', () => {
  assert.equal(resolveConfig({}).output, 'markdown')
  assert.equal(resolveConfig({}).requestTimeoutMs, 60_000)
  assert.throws(() => resolveConfig({ output: 'pdf' as Config['output'] }), /output must be one of/)
  assert.throws(() => resolveConfig({ tokenEnv: '' }), /tokenEnv/)
  assert.throws(() => resolveConfig({ maxFetchesPerSession: -1 }), /maxFetchesPerSession/)
  assert.throws(() => resolveConfig({ maxFetchesPerSession: 1.5 }), /maxFetchesPerSession/)
  assert.throws(() => resolveConfig({ maxContentChars: 0 }), /maxContentChars/)
  assert.throws(() => resolveConfig({ requestTimeoutMs: 0 }), /requestTimeoutMs/)
})
