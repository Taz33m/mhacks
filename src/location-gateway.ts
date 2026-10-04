import { createServer } from 'node:http';
import type { Server } from 'node:http';

/** Public mobile sharing surface. Never forwards pairing, dashboards, health or motion routes. */
export function createLocationGateway(upstreamPort: number | (() => number), fetcher: typeof fetch = fetch): Server {
  return createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    };
    const error = (status: number, message: string) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message }));
    };
    try {
      const path = new URL(req.url ?? '/', 'http://sharing.invalid');
      if (path.search || path.hash) return error(404, 'Not found.');
      const staticPaths = new Set(['/share-location', '/share-location.html', '/share-location.js', '/share-location.css',
        '/fonts/cormorant-regular.ttf', '/fonts/dm-sans-regular.ttf', '/fonts/aspekta-variable.woff2']);
      const sharingApi = path.pathname === '/api/location/share' && ['GET', 'POST', 'DELETE'].includes(req.method ?? '');
      if (!sharingApi && !(req.method === 'GET' && staticPaths.has(path.pathname))) return error(404, 'Not found.');
      let body: Buffer | undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length; if (bytes > 8000) return error(413, 'Location update is too large.');
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
      }
      const authorization = req.headers.authorization;
      if (sharingApi && (!authorization || authorization.length > 200)) return error(401, 'Open your private sharing link.');
      const port = typeof upstreamPort === 'function' ? upstreamPort() : upstreamPort;
      const response = await fetcher(`http://127.0.0.1:${port}${path.pathname}`, {
        method: req.method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { ...(authorization ? { Authorization: authorization } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength > 400_000) return error(502, 'Sharing service response unavailable.');
      res.writeHead(response.status, { ...headers, 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(payload);
    } catch { if (!res.headersSent) error(503, 'Location sharing is temporarily unavailable.'); else res.end(); }
  });
}
