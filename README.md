
# Analytics Proxy on Cloudflare Workers

Cloudflare Worker that proxies common analytics providers through your own domain to reduce blocking by strict filters and ad blockers.

## What This Worker Proxies

| Service | Default Public Route | Env Variable | Upstream |
| --- | --- | --- | --- |
| Google Tag Manager | `/tg/*` | `ROUTE_GTM` | `www.googletagmanager.com` |
| Google Analytics | `/an/*` | `ROUTE_GA` | `www.google-analytics.com` |
| Umami Script | `/stats/script.js` | `ROUTE_UMAMI_SCRIPT` | `cloud.umami.is/script.js` |
| Umami API | `/api/collect`, `/api/send` | `ROUTE_UMAMI_API` | `cloud.umami.is/api/send` |
| Microsoft Clarity | `/cla/*` | `ROUTE_CLARITY` | `www.clarity.ms`, `scripts.clarity.ms`, `q.clarity.ms`, `{region}.clarity.ms` |
| PostHog JS | `/phj/*` | `ROUTE_PH_JS` | `us-assets.i.posthog.com` |
| PostHog API | `/pha/*` | `ROUTE_PH_API` | `us.i.posthog.com` |

## Key Behavior

- `GET /health` returns `200 OK`.
- GA endpoint `/${ROUTE_GA}/g/e` is mapped to GA `/g/collect` and appends `_uip` from client IP.
- GTM `/${ROUTE_GTM}/script.js` is mapped upstream to `/gtag/js`.
- JavaScript responses are rewritten so embedded analytics hosts point back to your proxy routes.
- Umami collect endpoints only accept `POST` and `OPTIONS`.

## Environment Variables

Current defaults (from `wrangler.toml`):

```toml
ROUTE_GTM = "tg"
ROUTE_GA = "an"
ROUTE_UMAMI_SCRIPT = "stats"
ROUTE_UMAMI_API = "api"
ROUTE_CLARITY = "cla"
ROUTE_PH_JS = "phj"
ROUTE_PH_API = "pha"
CLARITY_PROXY_COLLECT = "false"
```

Notes:

- Route values are normalized (leading/trailing slashes are removed).
- `CLARITY_PROXY_COLLECT` accepts `true/false`, `1/0`, `yes/no`, `on/off`.
- If `CLARITY_PROXY_COLLECT` is not set, Worker fallback logic treats it as `true`.

Use either:

- `wrangler.toml` for shared defaults.
- `.dev.vars` for local overrides.

## Clarity Mode (`CLARITY_PROXY_COLLECT`)

- `true`: both Clarity script and collect stay on your proxy domain (`/cla/...`).
  Better bypass rate, but Clarity geo may reflect proxy/edge location.
- `false` (current project setting): script is proxied, collect is redirected (`307`) to Clarity hosts.
  Better dashboard geo accuracy, but collect requests are easier to block.

When `false`, these paths are redirected directly:

- `/${ROUTE_CLARITY}/collect` -> `https://q.clarity.ms/collect`
- `/${ROUTE_CLARITY}/{subdomain}/collect` -> `https://{subdomain}.clarity.ms/collect`

## Umami Integration

Use your proxy URL for script loading:

```html
<script
  defer
  src="https://your-domain.com/stats/script.js"
  data-website-id="42901071-7ec2-4417-8e48-d83c297ccf28"
  data-host-url="https://your-domain.com"
></script>
```

Do not use `https://cloud.umami.is/script.js` directly if you want requests to pass through your domain.

## Local Development

```bash
npm install
npm run dev
```

Default dev URL:

```text
http://127.0.0.1:8787
```

Quick checks:

```bash
curl http://127.0.0.1:8787/health
curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/tg/script.js?id=G-XXXXXXXX"
curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/an/g/e?v=2&tid=G-XXXXXXXX"
curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/stats/script.js"
curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:8787/api/collect" -H "content-type: application/json" -d "{}"
```

## Deploy

```bash
npm run deploy
```

## Project Structure

```text
Analytics-Proxy/
|-- src/
|   |-- index.js
|-- package.json
|-- wrangler.toml
|-- README.md
```
