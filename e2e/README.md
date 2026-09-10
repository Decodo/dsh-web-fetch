# End-to-end gates

Run against npm-latest dsh before any release and whenever dsh publishes a new
version. Results are written to `e2e/results/`, which is git-ignored. The bench
plugin is TypeScript that dsh loads unbuilt, so the runner needs Node 22.18 or
newer for native type stripping; the plugin itself still runs on Node 20.

```
SCRAPER_API_TOKEN=... ./e2e/run.sh
```

What it does, and how each gate is measured:

1. **Install and activation.** `dsh plugin add <this repo>` into a scratch
   headless profile, then `dsh --profile headless --dump-config`. Pass when the
   composed tree shows `tool-web` with `fetch: true` and `fetchTimeoutMs: 60000`,
   `web` with `fetchProvider: decodo`, and the `web-fetch-decodo` row, with the
   profile's own `cordis.patch.yml` untouched.
2. **Success rate.** `urls.json` holds 10 URLs that answered a plain curl with a
   non-200 (403/429) and 10 that answered 200. For each URL the bench does a
   direct `POST /v2/scrape` (`markdown: true`), then the same URL through
   `ctx.web.fetch` inside a booted dsh profile, rendered with dsh-tool-web's
   `formatFetchOutput`. Pass when dsh succeeds on at least 90% of the URLs where
   the direct call succeeds. Success = result status under 400 with non-empty
   content.
3. **Added latency.** Same pairs: median of (dsh ms - direct ms) at or under 1s,
   and zero dsh-side timeouts on URLs whose direct call finished within 20s.
   Absolute p50/p95 per group are reported as information.
4. **Missing credentials.** Same boot with `DECODO_API_KEY` and `SCRAPER_API_TOKEN`
   unset, one fetch. Pass when a clear error is thrown and no other provider
   answers. Two more runs with a wrong token and a wrong API key expect the
   API's auth error.

Method note: the bench is a throwaway plugin inserted with a `--patch` overlay
that disables the headless agent runner, so no model is in the loop. It calls
the exact seam method `web_fetch` calls, under an `AbortSignal.timeout` equal to
`fetchTimeoutMs` (what dsh-tool-call-timeout-policy arms around the tool). Model
latency and the policy wrapper itself are therefore excluded; everything from
profile boot, plugin activation, provider selection, the provider, and the
tool's rendering is included.

## With a model in the loop

For a real `web_fetch` call made by the agent, add a model overlay. Any
OpenAI-compatible endpoint works through the `llm-pi-ai` adapter;
`dev/model.patch.yml` reads `TEST_GATEWAY_URL`, `TEST_API_KEY`, and `TEST_MODEL`.

```
export DSH_HOME=<scratch>/home DECODO_API_KEY=... TEST_GATEWAY_URL=... TEST_API_KEY=... TEST_MODEL=...
dsh plugin --profile headless add <this repo>
dsh --profile headless --patch dev/model.patch.yml \
  "Call web_fetch on https://www.zillow.com/ and report the status and first heading"
```

Unset `SCRAPER_API_TOKEN` and run it again: the model must report the
provider-unavailable error, not page content. Both checks passed on 2026-09-08 against dsh 0.1.2-rc.1.
