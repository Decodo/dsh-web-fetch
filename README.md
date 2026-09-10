# Decodo for DeepSeek Harness

[![](https://dcbadge.limes.pink/api/server/https://discord.gg/Ja8dqKgvbZ)](https://discord.gg/Ja8dqKgvbZ)

<p align="center">
<a href="https://dashboard.decodo.com/integrations?utm_source=github&utm_medium=social&utm_campaign=dsh_web_fetch"> <img src="https://github.com/user-attachments/assets/a1e52a9e-3da1-4081-b3c6-053aafb8f196"/></a>
</p>

A fetch provider plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness), powered by the [Decodo Web Scraping API](https://decodo.com/scraping/web).

Install it and the agent's own `web_fetch` tool runs through Decodo. Pages that block an anonymous request come back anyway, converted to clean markdown, without you writing a tool, a prompt, or a line of scraping code.

- Works on sites that refuse a plain fetch: retail, real estate, jobs, ticketing
- Markdown by default, so the model reads prose instead of markup
- JavaScript rendering, anti-bot bypass, and CAPTCHA handling server-side
- 125M+ residential IPs across 195+ locations
- A per-session spend cap, because agents loop

## What is this?

dsh ships a built-in `web_fetch` tool and a provider seam behind it. This package registers Decodo on that seam and pins it as the provider, so every URL the agent opens is retrieved by Decodo instead of by an anonymous request from your machine.

Nothing about the agent's tool changes. `web_fetch` keeps its name, its schema, and its output format. Only the machinery behind it changes.

## Why use it?

dsh's built-in fetch provider makes a direct, anonymous HTTP request. That is fine for docs and blogs, and it stops working the moment the agent points at a site with bot protection. The agent gets a challenge page or a 403 and reports back that the page is empty.

Use this plugin when your agent needs to read the web as it actually is:

- **Protected sites.** Retail, real estate, jobs, travel, ticketing: the pages that block scripts by default.
- **JavaScript-heavy pages.** Rendered server-side before the content reaches the model.
- **Clean input for the model.** Decodo's markdown instead of a raw HTML document the agent has to wade through.
- **Geo-specific content.** Requests leave from Decodo's network, not your IP.

Fetch only. Search stays with whatever search provider your profile already uses.

## Key features

- **Every fetch goes through Decodo, with no tool selection.** The agent does not choose a scraping tool or learn a new one. It calls `web_fetch` as it always did.

- **Markdown by default.** The API returns Decodo's markdown and the plugin hands it to the model untouched. When conversion is not possible the raw HTML comes back and dsh converts it, so the model always gets readable text.

- **An explicit provider pin.** The bundle patch pins `fetchProvider: decodo` rather than relying on being the only provider mounted, so it keeps working when dsh ships its own.

- **A spend cap.** A configurable per-session ceiling on requests, with a clear error to the model when it is reached. Agent loops are the main bill-shock risk.

- **Errors the model can act on.** Auth, rate limit, validation, timeout, and scrape failures each map to a distinct code with a single-line message.

- **One command to install.** The package ships a dsh bundle patch, so `dsh plugin add` wires everything up with no config file to edit.

## Use cases

- **Competitive and pricing research.** Point an agent at retail or marketplace pages and let it read them.
- **Lead and company research.** Directory, listing, and profile pages that block anonymous requests.
- **Documentation and content gathering.** Long pages reduced to markdown before they reach the context window.
- **Agent workflows that already use dsh.** Add reliable fetching without changing prompts or tools.

## Quick start

1. **Create a free account** at [dashboard.decodo.com](https://dashboard.decodo.com/) and get up to 2K free requests, no credit card required.
2. **Get your API key** from the Decodo [dashboard](https://dashboard.decodo.com/).
3. **Install Node.js 20+** from [nodejs.org](https://nodejs.org/).
4. **Install dsh and this plugin** with the commands below.
5. **Ask the agent to fetch a page** that a plain request cannot reach.

```sh
pnpm add -g @deepseek-ai/dsh
dsh plugin --profile headless add @decodo/dsh-web-fetch
export DECODO_API_KEY='your-api-key'

dsh --profile headless "Fetch https://www.zillow.com/ and tell me the first heading"
```

## Installation

> **Requires [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)**

Use pnpm. dsh's own plugin manager forwards to it, and `npx @deepseek-ai/dsh` is known to hang npm's resolver for minutes.

```sh
pnpm add -g @deepseek-ai/dsh
dsh plugin --profile <name> add @decodo/dsh-web-fetch
```

`<name>` is the dsh profile you use, for example `headless` for one-shot runs or `web` for the browser UI. Install into each profile you want covered.

That is the whole install. The package ships a bundle patch that dsh inserts into the profile's layer stack, so there is no `cordis.patch.yml` to edit by hand.

## Authentication

Get an API key from the [Decodo dashboard](https://dashboard.decodo.com/).

```sh
# Preferred
export DECODO_API_KEY='your-api-key'

# Or the Web Scraping API Basic token, from the Playground
export SCRAPER_API_TOKEN='your-token'
```

**Precedence:** `DECODO_API_KEY` → `SCRAPER_API_TOKEN`, the same order the Decodo CLI uses. Both env var names are configurable. With neither set, the provider reports itself unavailable and the tool call fails with a clear error. It never falls back to another provider.

## Test your setup

```sh
dsh --profile <name> --dump-config | grep -A4 -E '^- id: (web|tool-web|web-fetch-decodo)$'
```

You should see `fetch: true`, `fetchProvider: decodo`, and the `web-fetch-decodo` row. Then ask the agent for a page that blocks anonymous requests:

```sh
dsh --profile headless "Fetch https://www.zillow.com/ and report the status and first heading"
```

A status of 200 with real page content means the fetch went through Decodo. Zillow answers a plain request with a 403.

## What installing changes in your profile

Installing this plugin is your explicit choice to enable `web_fetch`. The bundle patch:

- sets `tool-web` to `fetch: true` with a 60s `fetchTimeoutMs`, since dsh's default of 30s is short for protected sites,
- pins `web.fetchProvider: decodo` so this provider wins even when dsh's own `http` provider is mounted,
- inserts the `web-fetch-decodo` row with the config below.

dsh keeps its own `http` provider mounted. To switch back without uninstalling, override the pin in your profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

## Configuration

Override in your profile's `cordis.patch.yml`. A patch replaces the row's whole `config`, so restate every field you want to keep.

```yaml
- id: web-fetch-decodo
  config:
    apiKeyEnv: DECODO_API_KEY     # env var holding the Decodo API key (preferred)
    tokenEnv: SCRAPER_API_TOKEN   # env var holding the Web Scraping API Basic token (fallback)
    output: markdown              # markdown (default) or html
    maxFetchesPerSession: 200     # spend cap per dsh process; 0 disables
    maxContentChars: 200000       # body cap; longer bodies are cut and flagged truncated
    requestTimeoutMs: 60000       # request timeout, keep at or below the tool's fetchTimeoutMs
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `DECODO_API_KEY` | Env var read first; sent as Bearer auth |
| `tokenEnv` | `SCRAPER_API_TOKEN` | Fallback env var; sent as Basic auth |
| `output` | `markdown` | `markdown` for Decodo's markdown, `html` for the raw page |
| `maxFetchesPerSession` | `200` | Requests allowed per dsh process; `0` disables the cap |
| `maxContentChars` | `200000` | Body cap; longer bodies are cut and flagged truncated |
| `requestTimeoutMs` | `60000` | Request timeout |

With `output: markdown` the API is asked for markdown and the result reaches the model unchanged. When the API cannot convert a page, because it is oversized, empty, or the conversion failed, it returns raw HTML with a note, and the plugin lets dsh convert it instead. With `output: html` the raw page always comes back for dsh to convert.

## Spend cap

Every fetch counts against `maxFetchesPerSession`, including attempts that fail. Past the cap the tool returns an error naming the setting and makes no further API calls until dsh restarts or the cap is raised.

The counter is per dsh process. In a long-lived profile such as `web`, that is longer than one chat.

## Errors

Failures reach the model as `Error: <message>` with a machine-readable code.

| Code | Cause |
| --- | --- |
| `DECODO_TOKEN_MISSING` | Neither credential env var is set |
| `DECODO_AUTH_FAILED` | Credential rejected (401/403) |
| `DECODO_RATE_LIMITED` | Rate limit reached (429) |
| `DECODO_INVALID_REQUEST` | Request rejected (400/422), for example an unsupported URL |
| `DECODO_SCRAPE_FAILED` | Scrape failed, or an API error |
| `DECODO_FETCH_CAP_REACHED` | Spend cap hit |
| `DECODO_BAD_RESPONSE` | Response could not be read |
| `WEB_INVALID_URL` | Not an http(s) URL |
| `WEB_ABORTED` / `WEB_FETCH_TIMEOUT` | Cancelled or timed out |
| `WEB_PROVIDER_ERROR` | Could not reach the API |

A page that answers with a non-2xx status is a result, not an error. The model sees `Fetched <url> (HTTP <status>)` and whatever body came back, matching dsh's seam contract.

## Disclosures

- **Fetched content is untrusted input.** Pages can carry prompt-injection text. dsh labels fetched content as external data for the model; treat anything the agent reads from the web the same way.
- **URLs go through Decodo.** Every URL the agent fetches is sent to the Decodo Web Scraping API and retrieved from Decodo infrastructure, not from your machine. Decodo sees the URLs; the target site sees Decodo, not you.
- **Requests carry an `x-integration: dsh` header** so Decodo can attribute traffic to this plugin, the same way the Decodo CLI and MCP server tag theirs.
- **Each fetch is billed** as one Web Scraping API request on your Decodo account.

## Troubleshooting

**`configured web provider "decodo" is registered but unavailable`**

No credential is set. Export `DECODO_API_KEY` or `SCRAPER_API_TOKEN` in the environment dsh runs in.

**`configured web provider "decodo" is not registered`**

The plugin is not installed in the profile you are booting. Run `dsh plugin --profile <name> add @decodo/dsh-web-fetch` and check with `--dump-config`.

**`Decodo authentication failed`**

The credential was rejected. Check it in the [dashboard](https://dashboard.decodo.com/), and note that the API key and the Basic token are different values.

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
DECODO_API_KEY=... pnpm test:e2e      # gates against a fresh dsh install, see e2e/README.md
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

`@deepseek-ai/dsh-web` is a peer dependency, for `WebError` and the provider types.

### Branch protection

`.github/branch-ruleset.json` mirrors the ruleset on [Decodo/cli](https://github.com/Decodo/cli): pull requests only, two approvals, squash or rebase merges, no force pushes or branch deletion. GitHub rejects rulesets on private repositories under the organization's current plan, so apply it once this repository is public:

```sh
gh api repos/Decodo/dsh-web-fetch/rulesets -X POST --input .github/branch-ruleset.json
```

</details>

## Related repositories

- [Decodo Web Scraping API](https://github.com/Decodo/Web-Scraping-API)
- [Decodo CLI](https://github.com/Decodo/cli)
- [Decodo MCP server for IDE-based agent scraping](https://github.com/Decodo/mcp-server)
- [Decodo SDK for TypeScript](https://github.com/Decodo/sdk-ts)
- [Decodo agent skills](https://github.com/Decodo/agent-skills)

## Try it

Install the plugin and let your dsh agent read the pages it could not reach before.

[Start scraping for free](https://dashboard.decodo.com/) | [Web Scraping API documentation](https://help.decodo.com/docs/web-scraping-api-introduction) | [Discord](https://discord.gg/Ja8dqKgvbZ)

## License

All code is released under the [MIT License](https://github.com/Decodo/Decodo/blob/master/LICENSE).
