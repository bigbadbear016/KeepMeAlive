export interface Env {
  TARGET_URL?: string;
  HEALTH_ENDPOINT?: string;
  FALLBACK_ENDPOINT?: string;
  TIMEOUT_MS?: string;
  RETRY_ATTEMPTS?: string;
  ENABLE_FALLBACK?: string;
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

function targetUrls(env: Env): URL[] {
  const raw = env.TARGET_URL?.trim() ?? '';
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

async function executePing(env: Env): Promise<PingResult> {
  const started = Date.now();
  const targets = targetUrls(env);
  const timeoutMs = Math.max(1000, Number(env.TIMEOUT_MS) || 12_000);
  const attempts = Math.max(1, Number(env.RETRY_ATTEMPTS) || 2);
  const enableFallback = env.ENABLE_FALLBACK !== 'false';

  if (targets.length === 0) {
    return record({
      success: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      status: null,
      endpoint: '',
      fallback: false,
      targets: [],
      error: 'TARGET_URL must contain at least one valid HTTP or HTTPS URL',
    });
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
  return record({
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
  });
}

function record(result: PingResult): PingResult {
  lastPing = result;
  history.unshift(result);
  history.splice(MAX_HISTORY);
  return result;
}

function statusPage(env: Env): Response {
  const configured = targetUrls(env).length > 0;
  const status = lastPing?.success ? 'Stable' : lastPing ? 'Attention needed' : 'Awaiting first check';
  const color = lastPing?.success ? '#4ade80' : lastPing ? '#f87171' : '#94a3b8';
  const targetSummary = lastPing?.targets.length
    ? `${lastPing.targets.filter(target => target.success).length}/${lastPing.targets.length} targets responding`
    : 'No checks have run yet';
  const latest = lastPing
    ? `${targetSummary} · ${lastPing.durationMs} ms`
    : 'The Worker has not contacted the service yet.';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>KeepMeAlive</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { max-width: 720px; margin: 0 auto; padding: 48px 20px; background: #07090f; color: #f1f5f9; }
    .card { border: 1px solid #263244; border-radius: 16px; padding: 24px; background: #111827; }
    h1 { margin-top: 0; } .status { color: ${color}; font-size: 1.4rem; font-weight: 700; }
    p { color: #94a3b8; line-height: 1.6; } code { color: #4ade80; }
    button { border: 0; border-radius: 8px; padding: 10px 16px; background: #4ade80; color: #07110a; font-weight: 700; cursor: pointer; }
    .meta { font-size: .85rem; } a { color: #4ade80; }
  </style>
</head>
<body>
  <main class="card">
    <h1>KeepMeAlive</h1>
    <p>A lightweight heartbeat for one configured web service.</p>
    <div class="status">${status}</div>
    <p class="meta">${latest}</p>
    <p>${configured ? `${targetUrls(env).length} target${targetUrls(env).length === 1 ? '' : 's'} configured.` : 'Add TARGET_URL to start monitoring.'}</p>
    <form method="post" action="/ping"><button type="submit">Run a check</button></form>
    <p class="meta"><a href="/debug">Open diagnostics</a></p>
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

    if (url.pathname === '/' || url.pathname === '/status') return statusPage(env);

    if (url.pathname === '/ping' && (request.method === 'GET' || request.method === 'POST')) {
      const result = await executePing(env);
      return jsonResponse(result, result.success ? 200 : 502);
    }

    if (url.pathname === '/debug') {
      return jsonResponse({
        service: 'KeepMeAlive',
        targetConfigured: Boolean(env.TARGET_URL),
        targetCount: targetUrls(env).length,
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
