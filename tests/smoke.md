# Verifying the fix order

Everything below was run against this working tree. Nothing here needs Vercel.

## 1. The serverless function, on its own

```
node tests/request-signals.selftest.js
```

13 checks: valid submission, payload contents, email normalisation, secret header,
no secret in the response, honeypot (200 but never forwarded), short trade, bad email,
foreign origin, GET, form-encoded body, rate limit, missing `N8N_WEBHOOK_URL`.
Expected last line: `13 passed, 0 failed`.

## 2. The real form in a real browser

```
node tests/devserver.js          # terminal 1 — static files + the real handler
```

Then open `http://localhost:8900/`, scroll to the closing section, and:

| input | expected |
|---|---|
| `hi` + any email | red: "Tell me a bit more about what you sell…" |
| a real sentence + `nope` | red: "That email doesn't look right…" |
| a real sentence + a real address | green: "That's in…" and the two fields clear |
| fill `#company_site` first (the hidden field), then submit | green, but nothing reaches the webhook |

`http://localhost:8900/_received` lists what the stand-in webhook got — proof the
forward happened, without an n8n instance.

## 3. Before you publish

```
grep -n -E "\[\[|REPLACE_ME" index.html tutorials.html
```

Every hit is something only Caleb can fill:

- `[["your query"]]`, `[[date]]`, the four `[[N]]`, `[[paste the real post]]`,
  `[[platform]]`, `[[date posted]]`, `[[the problem behind the sentence]]`,
  `[[the first line]]` — from a real logged run of the tool.
- `REPLACE_ME_LINKEDIN`, `REPLACE_ME_X`, `REPLACE_ME_GITHUB` — the founder socials.
  They appear in four places: the `<head>` JSON-LD, the footer, and the `LINKS`
  object in each page's script. All must match.

## 4. Deploy settings

Vercel -> Project -> Settings -> Environment Variables:

- `N8N_WEBHOOK_URL` — required. The full webhook URL. It never appears in page source.
- `N8N_SECRET` — recommended. Sent as the `x-avn-secret` header; put the same value
  on the n8n Webhook node as a Header Auth check.
- `ALLOWED_ORIGIN` — optional, defaults to `https://aiverticalnetwork.com`.

Vercel -> Project -> Settings -> Domains: add `aiverticalnetwork.com`, add the DNS
records it shows, and `vercel.json` already 301s `www` to the root.
