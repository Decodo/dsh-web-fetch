# @decodo/dsh-web-fetch

Built-in `web_fetch` for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness), backed by Decodo.
Fetch that works on protected sites: the agent's own `web_fetch` tool runs through the
[Decodo Web Scraping API](https://help.decodo.com/docs/web-scraping-api) and gets Decodo's markdown back.

Fetch only. Search stays with whatever search provider your profile already uses.

## Install

Use pnpm (dsh's own plugin manager forwards to pnpm; `npx @deepseek-ai/dsh` is known to hang npm's resolver).

```sh
pnpm add -g @deepseek-ai/dsh
dsh plugin --profile <name> add @decodo/dsh-web-fetch     # e.g. --profile headless, --profile web
export SCRAPER_API_TOKEN=<your Web Scraping API token>    # the Basic token from the dashboard playground
```

That is the whole install. The package ships a bundle patch that dsh inserts into the profile's layer
stack, so no manual `cordis.patch.yml` edit is needed. Verify with:

```sh
dsh --profile <name> --dump-config | grep -A4 -E '^- id: (web|tool-web|web-fetch-decodo)$'
```

The token is the same one the Decodo MCP server and CLI use.

## What installing changes in your profile

Installing this plugin is your explicit choice to enable `web_fetch`. The bundle patch:

- sets `tool-web` to `fetch: true` with a 60s `fetchTimeoutMs` (dsh's default is 30s; protected sites can take longer),
- pins `web.fetchProvider: decodo` so this provider wins even when dsh's own `http` provider is mounted,
- inserts the `web-fetch-decodo` plugin row with the config below.

dsh keeps its own `http` fetch provider mounted. To switch back without uninstalling, override the pin in
your profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

## Configuration

Override in your profile's `cordis.patch.yml` (a patch replaces the row's whole `config`, so restate every field you want to keep):

```yaml
- id: web-fetch-decodo
  config:
    tokenEnv: SCRAPER_API_TOKEN   # env var holding the Web Scraping API Basic token
    output: markdown              # markdown (default) or html
    maxFetchesPerSession: 200     # spend cap per dsh process; 0 disables
    maxContentChars: 200000       # body cap; longer bodies are cut and flagged truncated
    requestTimeoutMs: 60000       # SDK-side request timeout, matches the tool's fetchTimeoutMs
```

- `output: markdown` asks the API for markdown and hands it to the model unchanged. When the API cannot convert a
  page (oversized, empty, conversion error) it returns raw HTML with a `help` note; the plugin detects that and lets dsh
  convert the HTML itself.
- `output: html` always returns raw HTML and lets dsh convert it.

## Spend cap

Agent loops are the main bill-shock risk, so every fetch counts against `maxFetchesPerSession` (attempts, including
failures). Past the cap the tool returns a clear error to the model and makes no further API calls until dsh restarts
or the cap is raised. The counter is per dsh process; in long-lived profiles such as `web` that is longer than one chat.

## Errors

Failures reach the model as `Error: <message>` with a code. The SDK's error classes map one to one: `AuthenticationError`
to `DECODO_AUTH_FAILED` (401/403), `RateLimitError` to `DECODO_RATE_LIMITED` (429), `ValidationError` and other 400/422
responses to `DECODO_INVALID_REQUEST`, `TimeoutError` to `WEB_FETCH_TIMEOUT`, any other `DecodoError` or a failed scrape
to `DECODO_SCRAPE_FAILED`. The plugin adds `DECODO_TOKEN_MISSING`, `DECODO_FETCH_CAP_REACHED`, and `DECODO_BAD_RESPONSE`. Shared seam codes
are reused where they fit: `WEB_INVALID_URL`, `WEB_ABORTED`, `WEB_FETCH_TIMEOUT`, `WEB_PROVIDER_ERROR` (transport).

A page that answers with a non-2xx status is a result, not an error: the model sees `Fetched <url> (HTTP <status>)` and
whatever body came back, matching dsh's seam contract.

With the token env var unset the provider reports itself unavailable and dsh fails the call with
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. It never falls back to another provider.

## Disclosures

- **Fetched content is untrusted input.** Pages can contain prompt-injection text. dsh already labels fetched content as
  external data for the model; treat anything the agent reads from the web accordingly.
- **URLs go through Decodo.** Every URL the agent fetches is sent to the Decodo Web Scraping API and fetched from
  Decodo infrastructure, not from your machine. Decodo sees the URLs; the target sees Decodo, not you.
- **Requests carry an `x-integration: dsh` header** so Decodo can attribute traffic to this plugin, the same
  way the Decodo CLI and MCP server tag theirs.
- **Each fetch is billed** as one Web Scraping API request on your Decodo account.

## Development

```sh
pnpm install
pnpm build               # tsc, src/ -> dist/ (what dsh loads)
pnpm test                # unit tests over src/ via node:test and Node's type stripping, no network
pnpm dev:setup           # installs dsh under dev/, isolated DSH_HOME in dev/home, links this repo into the headless and web profiles
pnpm dev "say hi and list your tools"     # one-shot headless run through the linked plugin
pnpm dev:web             # browser UI at http://127.0.0.1:3080
SCRAPER_API_TOKEN=... pnpm test:e2e       # gates against a fresh dsh install (see e2e/README.md)
```

`dev/dsh.sh` reads `SCRAPER_API_TOKEN` from the environment and falls back to the Decodo CLI token in
`~/.config/decodo/config.json`. The model comes from `dev/model.patch.yml`, an OpenAI-compatible route through the
`llm-pi-ai` adapter (Nexos gateway, `NEXOS_API_KEY`); swap in any endpoint you have. The plugin is linked and the wrapper rebuilds before each run, so edits to
`src/provider.ts` apply on the next run without reinstalling.

The HTTP layer is [`@decodo/sdk-ts`](https://github.com/Decodo/sdk-ts): it owns the endpoint, the Basic auth header, the
`x-integration` header, request validation, and the error classes the plugin maps onto dsh's `WebError` codes. The one thing the
SDK cannot do is take an external `AbortSignal`, so the plugin races the SDK call against dsh's signal: the tool call fails
promptly with `WEB_ABORTED` or `WEB_FETCH_TIMEOUT`, while the underlying request runs on until `requestTimeoutMs`. Keep that
value at or below the tool's `fetchTimeoutMs`. `@deepseek-ai/dsh-web` is a peer dependency for `WebError` and the provider types.
