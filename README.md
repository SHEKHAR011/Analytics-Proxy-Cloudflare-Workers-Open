
# Analytics Proxy on Cloudflare Workers

Cloudflare Worker that proxies common analytics providers through your own domain to reduce blocking by strict filters and ad blockers.

## What This Worker Proxies

| Service | Default Public Route | Env Variable | Upstream |
| --- | --- | --- | --- |
| Google Tag Manager | `/tg/*` | `ROUTE_GTM` | `www.googletagmanager.com` |
| Google Analytics | `/an/*` | `ROUTE_GA` | `www.google-analytics.com` |
| Umami Script | `/stats/script.js` | `ROUTE_UMAMI_SCRIPT` | `cloud.umami.is/script.js` |
| Umami API | `/api/collect`, `/api/send` | `ROUTE_UMAMI_API` | `cloud.umami.is/api/send` |

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
```

Notes:


Use either:

- `wrangler.toml` for shared defaults.
- `.dev.vars` for local overrides.


## Umami Integration

Use your proxy URL for script loading:

```html
<script
  defer
  src="https://your-domain.com/stats/script.js"
  data-website-id="xxxx-xxxxx-xxxxx-xxxxxx"
  data-host-url="https://your-domain.com"
></script>
```

Do not use `https://cloud.umami.is/script.js` directly if you want requests to pass through your domain.

## Example Proxy Snippets

```html
<!-- Umami Analytics Proxy -->
<script
  is:inline
  defer
  src="https://your-domain.com/stats/script.js"
  data-website-id="xxxxx-xxxxx-xxxxx-xxxx"
  data-host-url="https://your-domain.com"
></script>

<!-- Google Analytics Proxy -->
<script async src="https://your-domain.com/tg/script.js?id=G-xxxxxxxxxxx"></script>
<script is:inline>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-xxxxxxxxxx', {
    transport_url: 'https://your-domain.com/an'
  });
</script>
```

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
```

## Deploy

```bash
npm run deploy
```

## Acknowledgements

This project was built with help and inspiration from:

- [saki](https://github.com/rajnandan1/saki.git) by [@rajnandan1](https://github.com/rajnandan1)

Big thanks to both maintainers for sharing their work.

## Project Structure

```text
Analytics-Proxy/
|-- src/
|   |-- index.js
|-- package.json
|-- wrangler.toml
|-- README.md
```
