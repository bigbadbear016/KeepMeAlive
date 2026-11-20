# KeepMeAlive

> A small Cloudflare Worker that gives your web service a regular heartbeat.

Some hosting plans pause applications that receive no traffic. KeepMeAlive
visits one configured website or API on a schedule so it has a chance to
remain responsive. It works with Render, Railway, Fly.io, Koyeb, Replit, and
other services that accept HTTP requests.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bigbadbear016/KeepMeAlive)

## What you get

- A scheduled request every 10 minutes.
- A primary health route with an optional fallback route.
- Configurable timeouts and retry attempts.
- A readable status page at the Worker root URL.
- A manual check form for testing an additional site immediately.
- Persistent add/remove controls for monitored sites.
- Per-site ping, success, failure, and last-check counters.
- JSON output for scripts and monitoring tools.
- No accounts, dashboard database, or application data files.

KeepMeAlive is a wake-up helper, not an uptime-alerting platform. It does not
send email, SMS, or incident notifications.

## Quick start

### 1. Install and sign in

```bash
npm install
npx wrangler login
```

### 2. Choose the website

Enter one or more public website or API URLs in `TARGET_URL` in `wrangler.toml`, separated by a comma, pipe (`|`), or line break. Or use the **Deploy to Cloudflare
Workers** button above and enter the value in Cloudflare's setup form:

```toml
TARGET_URL = "https://example.com, https://api.example.com"
```

The same setup form lets you adjust the health path, fallback path, timeout,
retry count, and fallback switch. All targets are checked concurrently; the
run is successful only when every target succeeds.

### 3. Deploy

```bash
npm run deploy
```

Cloudflare will schedule the Worker using the cron expression in
`wrangler.toml`.

### 4. Check it

```bash
curl https://<your-worker-domain>/ping
```

## Worker routes

| Route | Methods | Response |
| --- | --- | --- |
| `/` or `/status` | `GET` | Small HTML status page |
| `/check` | `POST` | Manual site check from the status page |
| `/sites` | `POST` | Add or remove a persisted monitored site |
| `/ping` | `GET`, `POST` | Result of an immediate check |
| `/debug` | `GET` | Current settings and recent results |

Example successful response:

```json
{
  "success": true,
  "timestamp": "2026-11-20T06:00:00.000Z",
  "durationMs": 184,
  "status": 200,
  "endpoint": "/",
  "fallback": false
}
```

## Settings

All values are defined in `wrangler.toml` and can be changed in the
Cloudflare deployment form.

| Variable | Example | Meaning |
| --- | --- | --- |
| `TARGET_URL` | `https://example.com` | One or more website/API URLs separated by `,`, `|`, or new lines |
| `HEALTH_ENDPOINT` | `/` | First path to request |
| `FALLBACK_ENDPOINT` | `/healthz` | Optional path used after a failed first check |
| `TIMEOUT_MS` | `12000` | Maximum wait for each request |
| `RETRY_ATTEMPTS` | `2` | Attempts for each path |
| `ENABLE_FALLBACK` | `true` | Whether the second path is tried |

For a service with a dedicated health route, change the paths:

```toml
HEALTH_ENDPOINT = "/health"
FALLBACK_ENDPOINT = "/"
```

## Manual site checks

Open the Worker URL and use **Check another site manually** to test a URL
without changing `TARGET_URL`. The result is displayed immediately, but the
site is not added to the scheduled list and will not be checked again by the
cron job. For scripts, the same feature is available with:

```text
/ping?target=https://example.com
```

Manual targets support the same public HTTP/HTTPS validation as configured
targets.

## Persistent site management

Create a KV namespace and bind it to `KEEPALIVE_DATA`:

```bash
npx wrangler kv namespace create KEEPALIVE_DATA
```

Add the returned namespace ID to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KEEPALIVE_DATA"
id = "YOUR_NAMESPACE_ID"
```

The HTML add/remove controls do not require an admin token. The initial
monitored list comes from `TARGET_URL`. Later edits are stored in KV and
survive Worker restarts.

## Local development

Create a `.dev.vars` file (ignored by Git):

```dotenv
TARGET_URL=https://example.com|https://api.example.com
```

Start the local Worker:

```bash
npm run dev
```

Open `http://localhost:8787` or run `curl http://localhost:8787/ping`.

## Project layout

```text
src/worker.ts    Worker routes, scheduled checks, and status page
wrangler.toml   Cloudflare cron and deployment settings
package.json    Local development commands
```

## Safety notes

- Only `http` and `https` URLs are accepted.
- Localhost and private IPv4 addresses are rejected.
- Recent results exist only in the Worker instance memory and may disappear
  when Cloudflare replaces that instance.
- Do not put credentials or private tokens in the target URL.

## Credits

KeepMeAlive is created and maintained by
[bigbadbear016](https://github.com/bigbadbear016).

If this project helps you, please [star the official KeepMeAlive repository](https://github.com/bigbadbear016/KeepMeAlive)
and visit the author's [GitHub profile](https://github.com/bigbadbear016).

## License

MIT
