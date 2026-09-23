import { request } from 'node:https';

// Desktop-only transport: no cookies, redirects, proxy state, or renderer CORS.
// Abort destroys the request, rather than only hiding a still-running response.
export function desktopFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
      !(['www.youtube.com', 'youtube.com', 'openrouter.ai'].includes(target.hostname) ||
        target.hostname.endsWith('.youtube.com'))) {
      reject(new Error('Unsupported network destination.')); return;
    }
    const req = request(target, { method: options.method || 'GET', headers: options.headers,
      signal: options.signal }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); reject(new Error('Redirects are not allowed.')); return;
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 20_000_000) { req.destroy(new Error('Response exceeds 20 MB.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
