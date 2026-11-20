export interface Env {
  TARGET_URL?: string;
  HEALTH_ENDPOINT?: string;
  FALLBACK_ENDPOINT?: string;
  TIMEOUT_MS?: string;
  RETRY_ATTEMPTS?: string;
  ENABLE_FALLBACK?: string;
  KEEPALIVE_DATA?: KVNamespace;
}

interface PingResult {
  success: boolean;
  timestamp: string;
  durationMs: number;
  status: number | null;
  endpoint: string;
  fallback: boolean;
  targets: TargetResult[];
  error?: string;
}

interface TargetResult {
  target: string;
  success: boolean;
  status: number | null;
  endpoint: string;
  fallback: boolean;
  error?: string;
}

interface TargetStats {
  target: string;
  totalPings: number;
  successfulPings: number;
  failedPings: number;
  lastChecked: string | null;
  status: 'stable' | 'down' | 'unknown';
}

const history: PingResult[] = [];
let lastPing: PingResult | null = null;
const MAX_HISTORY = 20;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '0.0.0.0' ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function targetUrls(env: Env, rawValue = env.TARGET_URL): URL[] {
  const raw = rawValue?.trim() ?? '';
  const unique = new Set<string>();
  return raw
    .split(/[|,\r\n]+/)
    .map(value => parseTarget(value.trim()))
    .filter((url): url is URL => {
      if (!url || unique.has(url.href)) return false;
      unique.add(url.href);
      return true;
    });
}

const SITES_KEY = 'configuration:sites';

async function configuredUrls(env: Env): Promise<URL[]> {
  if (env.KEEPALIVE_DATA) {
    const stored = await env.KEEPALIVE_DATA.get(SITES_KEY);
    if (stored) {
      try {
        const urls = JSON.parse(stored);
        if (Array.isArray(urls)) {
          return targetUrls(env, urls.join(','));
        }
      } catch {
        // Fall back to TARGET_URL when stored configuration is invalid.
      }
    }
  }
  return targetUrls(env);
}

async function saveSites(env: Env, urls: URL[]): Promise<void> {
  await env.KEEPALIVE_DATA?.put(SITES_KEY, JSON.stringify(urls.map(url => url.href)));
}

async function readStats(env: Env, target: string): Promise<TargetStats> {
  const fallback: TargetStats = {
    target,
    totalPings: 0,
    successfulPings: 0,
    failedPings: 0,
    lastChecked: null,
    status: 'unknown',
  };
  if (!env.KEEPALIVE_DATA) return fallback;
  const stored = await env.KEEPALIVE_DATA.get(`stats:${encodeURIComponent(target)}`);
  if (!stored) return fallback;
  try {
    return { ...fallback, ...JSON.parse(stored) };
  } catch {
    return fallback;
  }
}

async function updateStats(env: Env, results: TargetResult[], timestamp: string): Promise<void> {
  if (!env.KEEPALIVE_DATA) return;
  await Promise.all(results.map(async result => {
    const previous = await readStats(env, result.target);
    const stats: TargetStats = {
      target: result.target,
      totalPings: previous.totalPings + 1,
      successfulPings: previous.successfulPings + (result.success ? 1 : 0),
      failedPings: previous.failedPings + (result.success ? 0 : 1),
      lastChecked: timestamp,
      status: result.success ? 'stable' : 'down',
    };
    await env.KEEPALIVE_DATA!.put(`stats:${encodeURIComponent(result.target)}`, JSON.stringify(stats));
  }));
}

function endpointUrl(base: URL, endpoint: string): string {
  return new URL(endpoint || '/', base).toString();
}

async function requestEndpoint(
  url: string,
  timeoutMs: number,
  attempts: number,
): Promise<{ status: number; ok: boolean; error?: string }> {
  let result: { status: number; ok: boolean; error?: string } = {
    status: 0,
    ok: false,
    error: 'Request failed',
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'KeepMeAlive/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      result = { status: response.status, ok: response.ok };
      if (result.ok) return result;
    } catch (error) {
      result = {
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }
  }
  return result;
}

async function executePing(
  env: Env,
  rawTargets = env.TARGET_URL,
  persist = true,
): Promise<PingResult> {
  const started = Date.now();
  const targets = persist
    ? await configuredUrls(env)
    : targetUrls(env, rawTargets);
  const timeoutMs = Math.max(1000, Number(env.TIMEOUT_MS) || 12_000);
  const attempts = Math.max(1, Number(env.RETRY_ATTEMPTS) || 2);
  const enableFallback = env.ENABLE_FALLBACK !== 'false';

  if (targets.length === 0) {
    const result = {
      success: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      status: null,
      endpoint: '',
      fallback: false,
      targets: [],
      error: 'TARGET_URL must contain at least one valid HTTP or HTTPS URL',
    };
    return persist ? record(result) : result;
  }

  const primary = env.HEALTH_ENDPOINT || '/';
  const fallback = env.FALLBACK_ENDPOINT || '/';
  const results = await Promise.all(targets.map(async base => {
    const primaryResult = await requestEndpoint(endpointUrl(base, primary), timeoutMs, attempts);
    if (primaryResult.ok || primary === fallback || !enableFallback) {
      return {
        target: base.href,
        success: primaryResult.ok,
        status: primaryResult.status || null,
        endpoint: primary,
        fallback: false,
        ...(primaryResult.error ? { error: primaryResult.error } : {}),
      };
    }

    const fallbackResult = await requestEndpoint(endpointUrl(base, fallback), timeoutMs, attempts);
    return {
      target: base.href,
      success: fallbackResult.ok,
      status: fallbackResult.status || null,
      endpoint: fallback,
      fallback: true,
      ...(fallbackResult.error ? { error: fallbackResult.error } : {}),
    };
  }));

  const first = results[0];
  const result = {
    success: results.every(result => result.success),
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - started,
    status: first.status,
    endpoint: first.endpoint,
    fallback: first.fallback,
    targets: results,
    ...(results.find(result => result.error)?.error
      ? { error: 'One or more targets could not be reached' }
      : {}),
  };
  if (persist) await updateStats(env, results, result.timestamp);
  return persist ? record(result) : result;
}

function record(result: PingResult): PingResult {
  lastPing = result;
  history.unshift(result);
  history.splice(MAX_HISTORY);
  return result;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character] ?? character));
}

const PAGE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f4f6fb; --bg-glow: #dbe7ff; --surface: #ffffff; --surface-2: #f1f4fa;
  --border: #e2e8f2; --text: #0f172a; --muted: #64748b; --accent: #4f46e5; --accent-text: #ffffff;
  --ok: #16a34a; --ok-bg: #dcfce7; --bad: #dc2626; --bad-bg: #fee2e2; --idle: #64748b; --idle-bg: #e2e8f0;
  --shadow: 0 1px 2px rgba(15,23,42,.04), 0 12px 32px rgba(15,23,42,.06);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #070b14; --bg-glow: #14204a; --surface: #0f1626; --surface-2: #141d31;
    --border: #1f2a44; --text: #e8edf8; --muted: #8b97b3; --accent: #818cf8; --accent-text: #0b1020;
    --ok: #4ade80; --ok-bg: #0d2b1b; --bad: #f87171; --bad-bg: #331616; --idle: #94a3b8; --idle-bg: #1a2338;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px rgba(0,0,0,.35);
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(1000px 420px at 50% -120px, var(--bg-glow), transparent 70%), var(--bg); color: var(--text); line-height: 1.5; }
.wrap { max-width: 880px; margin: 0 auto; padding: 32px 16px 56px; display: grid; gap: 20px; }
header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 12px; }
.logo { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: linear-gradient(135deg, #6366f1, #22c55e); color: #fff; font-size: 20px; box-shadow: var(--shadow); }
.brand h1 { margin: 0; font-size: 1.25rem; letter-spacing: -.02em; }
.brand p { margin: 0; color: var(--muted); font-size: .85rem; }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: .85rem; font-weight: 600; }
.pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.pill.ok { color: var(--ok); background: var(--ok-bg); } .pill.bad { color: var(--bad); background: var(--bad-bg); } .pill.idle { color: var(--idle); background: var(--idle-bg); }
.pill.ok::before { animation: pulse 2s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 currentColor; } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 20px; box-shadow: var(--shadow); }
.card h2 { margin: 0 0 14px; font-size: .95rem; letter-spacing: -.01em; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card h2 small { font-weight: 500; color: var(--muted); font-size: .8rem; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 16px; box-shadow: var(--shadow); }
.stat span { display: block; color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.stat strong { display: block; margin-top: 6px; font-size: 1.6rem; letter-spacing: -.03em; }
.stat em { font-style: normal; color: var(--muted); font-size: .8rem; }
.beat { display: flex; gap: 4px; align-items: flex-end; height: 36px; }
.beat i { flex: 1; min-width: 4px; max-width: 18px; height: 100%; border-radius: 4px; background: var(--ok); opacity: .9; }
.beat i.bad { background: var(--bad); } .beat i.empty { background: var(--surface-2); border: 1px dashed var(--border); opacity: 1; }
.sites { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.site { border: 1px solid var(--border); background: var(--surface-2); border-radius: 14px; padding: 14px 16px; display: grid; gap: 10px; }
.site-head { display: flex; align-items: center; gap: 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--idle); flex: none; }
.site.stable .dot { background: var(--ok); } .site.down .dot { background: var(--bad); }
.site-name { font-weight: 600; overflow-wrap: anywhere; flex: 1; font-size: .95rem; }
.badge { font-size: .72rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; color: var(--idle); background: var(--idle-bg); }
.site.stable .badge { color: var(--ok); background: var(--ok-bg); } .site.down .badge { color: var(--bad); background: var(--bad-bg); }
.bar { height: 6px; border-radius: 99px; background: var(--border); overflow: hidden; }
.bar b { display: block; height: 100%; background: var(--ok); border-radius: 99px; }
.site.down .bar b { background: var(--bad); }
.site-meta { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: .8rem; }
.site-actions { display: flex; justify-content: flex-end; }
.empty-state { text-align: center; padding: 28px 12px; color: var(--muted); }
.empty-state .big { font-size: 2rem; }
form { margin: 0; }
.field { display: flex; gap: 10px; flex-wrap: wrap; }
input[type=url] { flex: 1; min-width: 160px; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; font-size: .9rem; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { border: 0; border-radius: 10px; padding: 11px 18px; background: var(--accent); color: var(--accent-text); font: inherit; font-size: .9rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: transform .1s, opacity .15s; }
button:hover { opacity: .9; } button:active { transform: scale(.98); }
button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 6px 12px; font-size: .78rem; font-weight: 600; }
button.ghost:hover { color: var(--bad); border-color: var(--bad); opacity: 1; }
.hint { color: var(--muted); font-size: .8rem; margin: 10px 0 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
.results { list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 8px; }
.results li { display: grid; gap: 2px; padding: 10px 14px; border-radius: 10px; border-left: 4px solid var(--ok); background: var(--ok-bg); }
.results li.bad { border-left-color: var(--bad); background: var(--bad-bg); }
.results strong { font-size: .88rem; overflow-wrap: anywhere; } .results small { color: var(--muted); }
footer { display: flex; justify-content: center; gap: 18px; color: var(--muted); font-size: .85rem; flex-wrap: wrap; }
footer a { color: var(--accent); text-decoration: none; font-weight: 600; } footer a:hover { text-decoration: underline; }
@media (max-width: 720px) { .stats { grid-template-columns: repeat(2, 1fr); } .two { grid-template-columns: 1fr; } }
`;

const PAGE_JS = `
(function () {
  var rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
  function rel(iso) {
    var s = Math.round((new Date(iso).getTime() - Date.now()) / 1000), a = Math.abs(s);
    if (!rtf) return new Date(iso).toLocaleString();
    if (a < 60) return rtf.format(s, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }
  function tick() {
    document.querySelectorAll('[data-time]').forEach(function (el) { el.textContent = rel(el.getAttribute('data-time')); });
  }
  tick(); setInterval(tick, 15000);
})();
`;

async function statusPage(env: Env, manualResult?: PingResult): Promise<Response> {
  const loadedUrls: URL[] = await configuredUrls(env);
  const displayedResult = manualResult ?? lastPing;
  const overall = displayedResult ? (displayedResult.success ? 'ok' : 'bad') : 'idle';
  const overallLabel = displayedResult
    ? (displayedResult.success ? 'All systems operational' : 'Attention needed')
    : 'Awaiting first check';

  const siteStats = await Promise.all(loadedUrls.map((url: URL) => readStats(env, url.href)));
  const healthy = siteStats.filter(s => s.status === 'stable').length;
  const totalPings = siteStats.reduce((sum, s) => sum + s.totalPings, 0);
  const totalOk = siteStats.reduce((sum, s) => sum + s.successfulPings, 0);
  const rate = totalPings ? Math.round((totalOk / totalPings) * 1000) / 10 : null;
  const lastIso = lastPing?.timestamp ?? siteStats.map(s => s.lastChecked).filter(Boolean).sort().pop() ?? null;

  const beats = history.slice(0, MAX_HISTORY).reverse();
  const beatCells = [
    ...Array.from({ length: Math.max(0, MAX_HISTORY - beats.length) }, () => '<i class="empty" title="No data"></i>'),
    ...beats.map(b => `<i class="${b.success ? '' : 'bad'}" title="${escapeHtml(b.timestamp)} · ${b.durationMs} ms"></i>`),
  ].join('');

  const manualSection = manualResult ? `
    <ul class="results">
      ${manualResult.targets.map(target => `
      <li class="${target.success ? '' : 'bad'}">
        <strong>${escapeHtml(target.target)}</strong>
        <small>${target.success ? `Responded HTTP ${target.status} · ${manualResult.durationMs} ms` : escapeHtml(target.error ?? `HTTP ${target.status ?? 'unreachable'}`)}</small>
      </li>`).join('') || '<li class="bad"><strong>No valid URL</strong><small>Enter a valid public HTTP or HTTPS URL.</small></li>'}
    </ul>` : '';

  const siteItems = siteStats.map(stats => {
    const pct = stats.totalPings ? Math.round((stats.successfulPings / stats.totalPings) * 100) : 0;
    const label = stats.status === 'stable' ? 'Online' : stats.status === 'down' ? 'Down' : 'Pending';
    return `
    <li class="site ${stats.status}">
      <div class="site-head">
        <span class="dot"></span>
        <span class="site-name">${escapeHtml(stats.target)}</span>
        <span class="badge">${label}</span>
      </div>
      <div class="bar" title="${pct}% success"><b style="width:${stats.totalPings ? pct : 0}%"></b></div>
      <div class="site-meta">
        <span>${stats.totalPings ? `${pct}% uptime · ${stats.successfulPings} ok · ${stats.failedPings} failed` : 'No pings yet'}</span>
        <span>${stats.lastChecked ? `Checked <span data-time="${escapeHtml(stats.lastChecked)}">${escapeHtml(stats.lastChecked)}</span>` : 'Not checked'}</span>
      </div>
      <div class="site-actions">
        <form method="post" action="/sites">
          <input type="hidden" name="action" value="remove">
          <input type="hidden" name="target" value="${escapeHtml(stats.target)}">
          <button type="submit" class="ghost">Remove</button>
        </form>
      </div>
    </li>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${manualResult ? '' : '<meta http-equiv="refresh" content="60">'}
  <title>KeepMeAlive</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div class="brand">
        <div class="logo">♥</div>
        <div>
          <h1>KeepMeAlive</h1>
          <p>Heartbeat monitor · pings every 10 minutes</p>
        </div>
      </div>
      <span class="pill ${overall}">${overallLabel}</span>
    </header>

    <section class="stats">
      <div class="stat"><span>Sites</span><strong>${loadedUrls.length}</strong><em>${healthy} online</em></div>
      <div class="stat"><span>Uptime</span><strong>${rate === null ? '—' : `${rate}%`}</strong><em>${totalPings} total pings</em></div>
      <div class="stat"><span>Last check</span><strong style="font-size:1.1rem;margin-top:12px">${lastIso ? `<span data-time="${escapeHtml(lastIso)}">${escapeHtml(lastIso)}</span>` : '—'}</strong><em>${displayedResult ? `${displayedResult.durationMs} ms${manualResult ? ' · manual' : ''}` : 'waiting'}</em></div>
      <div class="stat"><span>Responding</span><strong>${displayedResult ? `${displayedResult.targets.filter(t => t.success).length}/${displayedResult.targets.length}` : '—'}</strong><em>latest run</em></div>
    </section>

    <section class="card">
      <h2>Recent checks <small>last ${MAX_HISTORY} runs (since worker start)</small></h2>
      <div class="beat">${beatCells}</div>
    </section>

    <section class="card">
      <h2>Monitored sites <small>${loadedUrls.length} configured</small></h2>
      ${siteItems
        ? `<ul class="sites">${siteItems}</ul>`
        : '<div class="empty-state"><div class="big">🌱</div><p>No monitored sites yet.<br>Add your first site below to start the heartbeat.</p></div>'}
    </section>

    <div class="two">
      <section class="card">
        <h2>Add a site</h2>
        <form method="post" action="/sites">
          <input type="hidden" name="action" value="add">
          <div class="field">
            <input type="url" name="target" placeholder="https://your-site.example.com" required>
          </div>
          <div class="field" style="margin-top:10px"><button type="submit">Add site</button></div>
        </form>
        <p class="hint">Sites are saved with the Worker’s KV storage.</p>
      </section>

      <section class="card">
        <h2>Quick check</h2>
        <form method="post" action="/check">
          <div class="field">
            <input id="target" name="target" type="url" placeholder="https://any-site.example.com" required>
            <button type="submit">Check</button>
          </div>
        </form>
        <p class="hint">Runs immediately and isn’t added to the schedule.</p>
        ${manualSection}
      </section>
    </div>

    <footer>
      <a href="/ping">Run configured check</a>
      <a href="/debug">Diagnostics</a>
    </footer>
  </div>
  <script>${PAGE_JS}</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/status') return await statusPage(env);

    if (url.pathname === '/check' && request.method === 'POST') {
      const form = await request.formData();
      const manualResult = await executePing(env, String(form.get('target') ?? ''), false);
      return await statusPage(env, manualResult);
    }

    if (url.pathname === '/sites' && request.method === 'POST') {
      if (!env.KEEPALIVE_DATA) {
        return jsonResponse({ success: false, error: 'KEEPALIVE_DATA KV binding is not configured' }, 503);
      }
      const form = await request.formData();
      const action = String(form.get('action') ?? '');
      const rawTarget = String(form.get('target') ?? '');
      if (action !== 'add' && action !== 'remove') {
        return jsonResponse({ success: false, error: 'Unsupported site action' }, 400);
      }
      const parsed = parseTarget(rawTarget);
      if (!parsed) {
        return jsonResponse({ success: false, error: 'Enter a valid public HTTP or HTTPS URL' }, 400);
      }

      const sites = await configuredUrls(env);
      const targetHref = parsed.href;
      const updated = action === 'remove'
        ? sites.filter(site => site.href !== targetHref)
        : [...new Map([...sites, parsed].map(site => [site.href, site])).values()];
      await saveSites(env, updated);
      return Response.redirect(new URL('/', request.url).toString(), 303);
    }

    if (url.pathname === '/ping' && (request.method === 'GET' || request.method === 'POST')) {
      const manualTarget = url.searchParams.get('target');
      const result = await executePing(env, manualTarget ?? env.TARGET_URL, !manualTarget);
      return jsonResponse(result, result.success ? 200 : 502);
    }

    if (url.pathname === '/debug') {
      const configured = await configuredUrls(env);
      return jsonResponse({
        service: 'KeepMeAlive',
        targetConfigured: configured.length > 0,
        targetCount: configured.length,
        healthEndpoint: env.HEALTH_ENDPOINT || '/',
        fallbackEndpoint: env.FALLBACK_ENDPOINT || '/',
        timeoutMs: Math.max(1000, Number(env.TIMEOUT_MS) || 12_000),
        retryAttempts: Math.max(1, Number(env.RETRY_ATTEMPTS) || 2),
        enableFallback: env.ENABLE_FALLBACK !== 'false',
        schedule: '*/10 * * * *',
        lastPing,
        history,
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await executePing(env);
  },
};