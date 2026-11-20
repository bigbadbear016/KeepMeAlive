export interface Env {
  TARGET_URL?: string;
  HEALTH_ENDPOINT?: string;
  FALLBACK_ENDPOINT?: string;
  TIMEOUT_MS?: string;
  RETRY_ATTEMPTS?: string;
  ENABLE_FALLBACK?: string;
  KEEPALIVE_DATA?: KVNamespace;
  ADMIN_TOKEN?: string;
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

async function statusPage(env: Env, manualResult?: PingResult): Promise<Response> {
  const loadedUrls: URL[] = await configuredUrls(env);
  const configured = loadedUrls.length > 0;
  const displayedResult = manualResult ?? lastPing;
  const status = displayedResult?.success ? 'Stable' : displayedResult ? 'Attention needed' : 'Awaiting first check';
  const color = displayedResult?.success ? '#4ade80' : displayedResult ? '#f87171' : '#94a3b8';
  const targetSummary = displayedResult?.targets.length
    ? `${displayedResult.targets.filter(target => target.success).length}/${displayedResult.targets.length} targets responding`
    : 'No checks have run yet';
  const latest = displayedResult
    ? `${targetSummary} · ${displayedResult.durationMs} ms${manualResult ? ' · manual check' : ''}`
    : 'The Worker has not contacted the service yet.';
  const manualRows = manualResult?.targets.map(target => `
    <li class="${target.success ? 'ok' : 'bad'}">
      <span>●</span>
      <strong>${escapeHtml(target.target)}</strong>
      <small>${target.success ? `HTTP ${target.status}` : escapeHtml(target.error ?? `HTTP ${target.status ?? 'unreachable'}`)}</small>
    </li>`).join('') ?? '';
  const manualMessage = manualResult
    ? `<section class="results"><h2>Manual check</h2><ul>${manualRows}</ul></section>`
    : '';
  const siteStats = await Promise.all(loadedUrls.map((url: URL) => readStats(env, url.href)));
  const siteRows = siteStats.map(stats => `
    <li class="${stats.status}">
      <span>●</span>
      <strong>${escapeHtml(stats.target)}</strong>
      <small>${stats.totalPings} pings · ${stats.successfulPings} success · ${stats.failedPings} failed${stats.lastChecked ? ` · ${escapeHtml(stats.lastChecked)}` : ' · not checked'}</small>
      <form method="post" action="/sites">
        <input type="hidden" name="action" value="remove">
        <input type="hidden" name="target" value="${escapeHtml(stats.target)}">
        <input type="password" name="token" placeholder="Admin token" required>
        <button type="submit" class="remove">Remove</button>
      </form>
    </li>`).join('');
  const siteSection = `
    <section class="results">
      <h2>Monitored sites</h2>
      ${siteRows ? `<ul class="sites">${siteRows}</ul>` : '<p class="meta">No monitored sites yet.</p>'}
      <form method="post" action="/sites" class="manage">
        <input type="hidden" name="action" value="add">
        <input type="url" name="target" placeholder="https://your-site.example.com" required>
        <input type="password" name="token" placeholder="Admin token" required>
        <button type="submit">Add site</button>
      </form>
    </section>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>KeepMeAlive</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; } body { max-width: 760px; margin: 0 auto; padding: 32px 16px; background: radial-gradient(circle at top, #172554, #07090f 45%); color: #f8fafc; }
    .card { border: 1px solid #263244; border-radius: 24px; padding: clamp(24px, 5vw, 42px); background: rgba(15, 23, 42, .92); box-shadow: 0 24px 70px #020617aa; }
    .eyebrow { color: #4ade80; font-size: .75rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 8px 0; font-size: clamp(2rem, 8vw, 3.2rem); letter-spacing: -.05em; } h2 { font-size: 1rem; margin-bottom: 12px; }
    p { color: #a5b4fc; line-height: 1.6; } .status { color: ${color}; font-size: 1.35rem; font-weight: 800; margin-top: 24px; }
    .meta { color: #94a3b8; font-size: .9rem; } a { color: #86efac; }
    form { display: grid; gap: 10px; margin-top: 28px; } label { color: #cbd5e1; font-size: .9rem; font-weight: 700; }
    .input-row { display: flex; gap: 10px; } input { min-width: 0; flex: 1; border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; background: #020617; color: #f8fafc; font: inherit; }
    button { border: 0; border-radius: 10px; padding: 12px 18px; background: #4ade80; color: #052e16; font-weight: 800; cursor: pointer; white-space: nowrap; } button:hover { background: #86efac; }
    .results { border-top: 1px solid #263244; margin-top: 28px; padding-top: 18px; } ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    li { display: grid; grid-template-columns: 18px 1fr; gap: 4px 8px; padding: 10px 12px; border-radius: 10px; background: #0b1220; } li span { grid-row: span 2; color: #4ade80; } li.bad span, li.down span { color: #f87171; } li strong { overflow-wrap: anywhere; font-size: .9rem; } li small { color: #94a3b8; }
    .sites li { grid-template-columns: 18px 1fr auto; } .sites li form { grid-column: 2 / 4; display: grid; grid-template-columns: minmax(120px, 180px) auto; justify-content: start; margin: 6px 0 0; } .sites li small { grid-column: 2; } .remove { background: #7f1d1d; color: #fecaca; } .manage { grid-template-columns: 1fr 180px auto; } .manage input { width: 100%; }
    @media (max-width: 520px) { .input-row, .manage { display: grid; } .sites li { grid-template-columns: 18px 1fr; } .sites li form { grid-column: 2; grid-template-columns: 1fr auto; } }
    @media (max-width: 520px) { .input-row { display: grid; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="eyebrow">Cloudflare Worker</div>
    <h1>KeepMeAlive</h1>
    <p>A lightweight heartbeat for services that need a little traffic to stay awake.</p>
    <div class="status">${status}</div>
    <p class="meta">${latest}</p>
    <p>${configured ? `${loadedUrls.length} target${loadedUrls.length === 1 ? '' : 's'} configured.` : 'Add a monitored site to start.'}</p>
    <form method="post" action="/check">
      <label for="target">Check another site manually</label>
      <div class="input-row">
        <input id="target" name="target" type="url" placeholder="https://your-site.example.com" required>
        <button type="submit">Check site</button>
      </div>
      <span class="meta">Manual checks are immediate and are not added to the scheduled target list.</span>
    </form>
    ${manualMessage}
    ${siteSection}
    <p class="meta"><a href="/ping">Run configured check</a> · <a href="/debug">Open diagnostics</a></p>
  </main>
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
      if (!env.ADMIN_TOKEN) {
        return jsonResponse({ success: false, error: 'ADMIN_TOKEN is not configured' }, 503);
      }
      const form = await request.formData();
      const token = String(form.get('token') ?? '');
      if (token !== env.ADMIN_TOKEN) {
        return jsonResponse({ success: false, error: 'Invalid admin token' }, 401);
      }

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
