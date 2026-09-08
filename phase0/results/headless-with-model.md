# Model-in-the-loop check, 2026-09-08

dsh 0.1.2-rc.1, headless profile, plugin installed via `dsh plugin add`, model
Claude Sonnet 4.6 through the Nexos gateway (`phase0/model.patch.example.yml`).

## Token set

Prompt: list tools, then `web_fetch` https://www.zillow.com/ and report status, title, first heading.

Answer (abridged): HTTP 200, page identified as "Zillow Real Estate", first
heading "Rentals. Homes. Agents. Loans." Zillow answers a plain curl with 403,
so the content came through Decodo.

## Token unset

Prompt: `web_fetch` https://www.zillow.com/ and report verbatim what the tool returned.

Answer: the tool returned

```
Error: configured web provider "decodo" is registered but unavailable
```

No page content, no fallback to dsh's built-in `http` provider.
