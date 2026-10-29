const token = process.env.OCF_BUN_TOKEN;
const allowedOrigin = process.env.OCF_BUN_ALLOWED_ORIGIN;

if (!token || !allowedOrigin) {
  console.error('zen-bun-sidecar: OCF_BUN_TOKEN and OCF_BUN_ALLOWED_ORIGIN are required');
  process.exit(1);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/fetch') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    if (request.headers.get('x-ocf-bun-token') !== token) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON request' }, { status: 400 });
    }

    let target;
    try {
      target = new URL(payload.url);
    } catch {
      return Response.json({ error: 'invalid target URL' }, { status: 400 });
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== allowedOrigin) {
      return Response.json({ error: 'target origin is not allowed' }, { status: 403 });
    }

    try {
      const response = await fetch(target, {
        method: payload.method || 'POST',
        headers: payload.headers,
        body: payload.body,
        signal: AbortSignal.timeout(Number(payload.timeoutMs) || 180_000),
      });
      return Response.json({
        status: response.status,
        body: await response.text(),
      });
    } catch (error) {
      return Response.json(
        { error: error?.message ?? String(error) },
        { status: 502 },
      );
    }
  },
});

console.log(JSON.stringify({ ready: true, url: server.url.href }));

process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
