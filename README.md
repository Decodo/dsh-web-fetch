# Decodo for DeepSeek Harness

[![Join the Decodo Discord](https://dcbadge.limes.pink/api/server/https://discord.gg/Ja8dqKgvbZ)](https://discord.gg/Ja8dqKgvbZ)

<p align="center">
<a href="https://dashboard.decodo.com/integrations?utm_source=github&utm_medium=social&utm_campaign=dsh_web_fetch"> <img src="https://github.com/user-attachments/assets/a1e52a9e-3da1-4081-b3c6-053aafb8f196" alt="Decodo Web Scraping API integration for DeepSeek Harness"/> 
</a>
</p>

A web fetch plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) that routes the agent's built-in `web_fetch` tool through the Decodo [Web Scraping API](https://decodo.com/scraping/web) to retrieve content from sites that block anonymous requests.

Install the plugin and the agent keeps calling `web_fetch` as usual. Decodo retrieves the page and returns readable content, with Markdown by default. You don't need to add a new agent tool or change its prompts.

- Fetch pages that may return a `403` or bot challenge to a direct request, including retail, real estate, and job listings.
- Handle bot protection through the API. Some sites may still reject a request.
- Give the model Markdown by default; if Decodo returns HTML, dsh converts it to readable text.
- Set a per-process fetch cap so an agent loop cannot keep making API requests indefinitely.

[Create a Decodo account](https://dashboard.decodo.com/) to start a free plan with up to 2K requests. No credit card required.

## How Decodo works with DeepSeek Harness

DeepSeek Harness exposes a built-in `web_fetch` tool with a provider seam behind it. The plugin registers Decodo at that seam and pins it as the fetch provider for the profile where you install it.

The agent still calls `web_fetch` with the same name and schema, and receives the same tool output format. The retrieval happens through Decodo rather than a direct request from the DeepSeek Harness process. The plugin does not replace `web_search`.

## When to use the Decodo plugin

A direct fetch may receive a `403` or a bot challenge. For AI agent web scraping, Decodo handles retrieval with anti-bot and CAPTCHA handling to help bypass bot detection where possible. Success still depends on the target page.

Use this plugin when your agent needs to read the web as it actually is:

- **Blocked sites**. Fetch retail, real estate, travel, or ticketing pages that may reject anonymous requests.
- **Readable input**. Pass Markdown to the model when the API can convert the page; DeepSeek Harness converts returned HTML otherwise.
- **Location-dependent pages**. Retrieve through Decodo's residential IP network instead of your machine's IP. This plugin does not expose a location selector in the configuration below.

The plugin gives the agent an API-backed fetch provider without requiring you to configure a separate web scraping proxy. Fetching uses Decodo; search remains with your profile's existing search provider.

## Key features

- **Every fetch goes through Decodo, with no tool selection**. The agent does not choose a scraping tool or learn a new one. It calls `web_fetch` as it always did.

- **Markdown by default**. The API returns Decodo's Markdown and the plugin hands it to the model untouched. When conversion isn't possible, the raw HTML comes back and DeepSeek Harness converts it, so the model always gets readable text.

- **An explicit provider pin**. The bundle patch pins `fetchProvider: decodo` rather than relying on being the only provider mounted, so it keeps working when other providers are mounted.

- **A fetch limit**. A configurable per-process ceiling on requests, with a clear error to the model when it is reached. Agent loops are the main bill-shock risk.

- **Errors the model can act on**. Auth, rate limit, validation, timeout, and scrape failures each map to a distinct code with a single-line message.

- **Install with the `dsh` CLI**. The package ships a DeepSeek Harness bundle patch, so `dsh plugin --profile <name> add` wires everything up with no config file to edit.

## Use cases

- **Competitive and pricing research**. Point an agent at retail or marketplace pages and let it read them.
- **Lead and company research**. Directory, listing, and profile pages that block anonymous requests.
- **Documentation and content gathering**. Long pages reduced to Markdown before they reach the context window.
- **Existing DeepSeek Harness workflows**. Add API-backed fetching without changing prompts or tools.

## Quick start

1. **Create an account** on the Decodo [dashboard](https://dashboard.decodo.com/).
2. **Get your Web Data API key** from the Decodo [Playground](https://dashboard.decodo.com/web-data/playground). Older plans only have a basic auth token, which also works.
3. **Install Node.js 20+ and pnpm 10.x** using the instructions at [nodejs.org](https://nodejs.org/) and [pnpm.io](https://pnpm.io/).
4. **Install DeepSeek Harness and this plugin** with the commands below.
5. **Ask the agent to fetch a page** and check the status and content it returns.

```sh
pnpm add -g @deepseek-ai/dsh
dsh plugin --profile headless add @decodo/dsh-web-fetch
export DECODO_API_KEY='your-api-key'

dsh --profile headless "Fetch https://www.zillow.com/ and tell me the first heading"
```

## Installation

> **Requires [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)**

Use pnpm for this DeepSeek Harness install. The `dsh` CLI plugin manager forwards to pnpm.

```sh
pnpm add -g @deepseek-ai/dsh
dsh plugin --profile <name> add @decodo/dsh-web-fetch
```

`<name>` is the dsh profile you use, for example `headless` for one-shot runs or `web` for the browser UI. Install into each profile you want covered.

That's the whole install. The package ships a bundle patch that dsh inserts into the profile's layer stack, so there is no `cordis.patch.yml` to edit by hand.

## Authentication

Copy your Web Data API key from the [Playground](https://dashboard.decodo.com/web-data/playground) and export it before starting DeepSeek Harness:

```sh
export DECODO_API_KEY='your-api-key'
```

Older plans only have a basic authentication token. Export it as `SCRAPER_API_TOKEN` instead. If both are set, the API key is used.

## Test your setup

```sh
dsh --profile <name> --dump-config | grep -A4 -E '^- id: (web|tool-web|web-fetch-decodo)$'
```

You should see `fetch: true`, `fetchProvider: decodo`, and the `web-fetch-decodo` row. Then ask the agent to fetch a page:

```sh
dsh --profile headless "Fetch https://www.zillow.com/ and report the status and first heading"
```

Check that the tool returns a status and page content. The response may vary by site and time; an HTTP 200 alone does not establish which provider handled the fetch, so also check the pinned provider in `--dump-config`.

## What the plugin changes in your profile

Installing this plugin is your explicit choice to enable `web_fetch`. The bundle patch:

- sets `tool-web` to `fetch: true` with a 60s `fetchTimeoutMs`, since dsh's default of 30s is short for protected sites,
- pins `web.fetchProvider: decodo` so this provider wins even when the built-in `http` provider is mounted,
- inserts the `web-fetch-decodo` row with the config below.

dsh keeps its built-in `http` provider mounted. To switch back without uninstalling, add or update the `web` row in your profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

This example assumes your current search provider is `deepseek-official`. If it differs, use your existing `searchProvider` value. The patch replaces the row's entire `config`, so carry over any other settings you want to keep. You can check the current values with `dsh --profile <name> --dump-config`.

## Configuration

Override in your profile's `cordis.patch.yml`. A patch replaces the row's whole `config`, so restate every field you want to keep.

```yaml
- id: web-fetch-decodo
  config:
    apiKeyEnv: DECODO_API_KEY     # env var holding the Web Data API key
    tokenEnv: SCRAPER_API_TOKEN   # env var holding the basic auth token (older plans)
    output: markdown              # markdown (default) or html
    maxFetchesPerSession: 200     # fetch limit per dsh process; 0 disables
    maxContentChars: 200000       # body cap; longer bodies are cut and flagged truncated
    requestTimeoutMs: 60000       # request timeout, keep at or below the tool's fetchTimeoutMs
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `DECODO_API_KEY` | Env var holding the Web Data API key; sent as Bearer auth. Takes precedence over the token |
| `tokenEnv` | `SCRAPER_API_TOKEN` | Env var holding the basic auth token for older plans; sent as Basic Auth |
| `output` | `markdown` | `markdown` for Decodo's Markdown, `html` for the raw page |
| `maxFetchesPerSession` | `200` | Requests allowed per dsh process; `0` disables the cap |
| `maxContentChars` | `200000` | Body cap; longer bodies are cut and flagged truncated |
| `requestTimeoutMs` | `60000` | Request timeout |

With `output: markdown`, the plugin requests Markdown from Decodo. When conversion succeeds, the plugin passes the result to the model unchanged. If the page is too large or empty, or if conversion fails, Decodo returns raw HTML with a note. DeepSeek Harness then converts the HTML. With `output: html`, Decodo always returns raw HTML for DeepSeek Harness to convert.

## Fetch limit

Every fetch counts against `maxFetchesPerSession`, including attempts that fail. Past the cap, the tool returns an error naming the setting and makes no further API calls until `dsh` restarts or the cap is raised.

The counter is per `dsh` process, so in a long-lived profile such as `web`, it may span multiple chats.

## Errors

Failures reach the model as `Error: <message>` with a machine-readable code.

| Code | Cause |
| --- | --- |
| `DECODO_TOKEN_MISSING` | No credential is configured |
| `DECODO_AUTH_FAILED` | Credential rejected (401/403) |
| `DECODO_RATE_LIMITED` | Rate limit reached (429) |
| `DECODO_INVALID_REQUEST` | Request rejected (400/422), for example, because the URL is unsupported |
| `DECODO_SCRAPE_FAILED` | Scrape failed or the API returned an error |
| `DECODO_FETCH_CAP_REACHED` | Fetch limit hit |
| `DECODO_BAD_RESPONSE` | Response couldn't be read |
| `WEB_INVALID_URL` | Not an http(s) URL |
| `WEB_ABORTED` / `WEB_FETCH_TIMEOUT` | Cancelled or timed out |
| `WEB_PROVIDER_ERROR` | Couldn't reach the API |

A page that answers with a non-2xx status is a result, not an error. The model sees `Fetched <url> (HTTP <status>)` and whatever body came back, matching dsh's provider contract.

## Disclosures

- **Fetched content is untrusted input**. Pages can carry prompt-injection text. DeepSeek Harness labels fetched content as external data for the model; treat anything the agent reads from the web the same way.
- **URLs go through Decodo**. Every URL the agent fetches is sent to the Decodo Web Scraping API and retrieved from Decodo infrastructure, not from your machine. Decodo sees the URLs; the target site sees Decodo, not you.
- **Requests carry an `x-integration: dsh` header** so Decodo can attribute traffic to this plugin, the same way the Decodo CLI and MCP server tag theirs.
- **Decodo plan usage**. Every fetch attempt counts toward this plugin's `maxFetchesPerSession` limit, including failed attempts. Only successful scrapes count toward your Decodo plan's usage.

## Troubleshooting

**`configured web provider "decodo" is registered but unavailable`**

No credential is set. Export `DECODO_API_KEY` (or `SCRAPER_API_TOKEN` on older plans) in the environment where dsh runs.

**`configured web provider "decodo" is not registered`**

The plugin isn't installed in the profile you're booting. Run `dsh plugin --profile <name> add @decodo/dsh-web-fetch` and check with `--dump-config`.

**`Decodo authentication failed`**

Check your API key (or basic auth token on older plans) in the [Playground](https://dashboard.decodo.com/web-data/playground) and confirm that `DECODO_API_KEY` (or `SCRAPER_API_TOKEN`) is exported in the environment where DeepSeek Harness runs.

**The agent says the page was empty**

Check the status in the tool output. A non-2xx status is reported as a result, so the model sees what the site returned.

**Tool calls time out**

Raise `fetchTimeoutMs` on the `tool-web` row and keep `requestTimeoutMs` at or below it.

## Development

<details>

### Prerequisites

- Node.js 20+ (22.18+ for the e2e suite, which runs TypeScript unbuilt)
- [pnpm](https://pnpm.io/) 10.x (`corepack enable` if needed)

### Install and build

```sh
git clone https://github.com/Decodo/dsh-web-fetch
cd dsh-web-fetch
pnpm install
pnpm build
```

### Tests and checks

```sh
pnpm typecheck
pnpm test                             # unit tests, no network
pnpm test:e2e                         # requires credentials; see e2e/README.md
```

### Run it against a real agent

```sh
pnpm dev:setup                                    # installs dsh under dev/, links this repo into the profiles
pnpm dev "say hi and list your tools"             # one-shot headless run
pnpm dev:web                                      # browser UI at http://127.0.0.1:3080
```

`dev/dsh.sh` reads the credential from the environment and falls back to the Decodo CLI token in `~/.config/decodo/config.json`. The model comes from `dev/model.patch.yml`, an OpenAI-compatible route configured by `TEST_GATEWAY_URL`, `TEST_API_KEY`, and `TEST_MODEL`; any chat-completions endpoint works. The plugin is linked and the wrapper rebuilds before each run, so edits to `src/provider.ts` apply on the next run.

### Implementation notes

The HTTP layer is [`@decodo/sdk-ts`](https://github.com/Decodo/sdk-ts). It owns the endpoint, the auth header, the `x-integration` header, request validation, and the error classes the plugin maps onto dsh's `WebError` codes. The one thing the SDK cannot do is accept an external `AbortSignal`, so the plugin races the SDK call against dsh's signal: the tool call fails promptly on abort or timeout while the underlying request runs on until `requestTimeoutMs`. Keep that value at or below the tool's `fetchTimeoutMs`.

`@deepseek-ai/dsh-web` is a peer dependency for `WebError` and the provider types.

### Branch protection

`.github/branch-ruleset.json` mirrors the ruleset on [Decodo/cli](https://github.com/Decodo/cli): pull requests only, two approvals, squash or rebase merges, no force pushes or branch deletion. GitHub rejects rulesets on private repositories under the organization's current plan, so apply it once this repository is public:

```sh
gh api repos/Decodo/dsh-web-fetch/rulesets -X POST --input .github/branch-ruleset.json
```

</details>

## Other DeepSeek Harness fetch providers

DeepSeek Harness plugins can provide different backends for the same `web_fetch` tool. Choose according to how you want pages retrieved:

| Provider | Retrieval approach |
| --- | --- |
| Decodo (this plugin) | Decodo's hosted Web Scraping API, with an API key or basic auth token and request-based usage |
| [`dsh-web-fetch-playwright`](https://github.com/chendefine/dsh-web-fetch-playwright) | A local Playwright browser or an existing browser over CDP |
| [`dsh-web-fetch-crw`](https://www.npmjs.com/package/%40jaco-tech/dsh-web-fetch-crw) | Your self-hosted crw service through its Firecrawl-compatible API |

These are separate fetch providers with their own setup and behavior. Review their documentation for current requirements.

## Related repositories

- [Decodo Web Scraping API](https://github.com/Decodo/Web-Scraping-API)
- [Decodo CLI](https://github.com/Decodo/cli)
- [Decodo MCP server for IDE-based agent scraping](https://github.com/Decodo/mcp-server)
- [Decodo SDK for TypeScript](https://github.com/Decodo/sdk-ts)
- [Decodo agent skills](https://github.com/Decodo/agent-skills)

## Try it for free

Install the plugin and let your dsh agent fetch pages through Decodo.

[Start scraping for free](https://dashboard.decodo.com/) | [Web Scraping API documentation](https://help.decodo.com/docs/web-scraping-api-introduction) | [Discord](https://discord.gg/Ja8dqKgvbZ)

## License

All code is released under the [MIT License](LICENSE).
