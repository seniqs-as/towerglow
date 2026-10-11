import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';

/**
 * The package root must be SEARCHED for, not inferred by counting levels: the
 * same file runs both from the sources (src/server/) and from the build
 * (dist/server/server/), and a fixed relative path works in only one of the two.
 */
function findPackageRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(findPackageRoot(HERE), 'dist', 'client');

export function clientDirExists(): boolean {
  return fs.existsSync(path.join(CLIENT_DIR, 'index.html'));
}

export function clientDir(): string {
  return CLIENT_DIR;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Authoritative CSP. `default-src 'none'` is the pillar: any external resource
 * fails at browser level even if a bug introduced it.
 */
function cspFor(port: number): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function securityHeaders(port: number): Record<string, string> {
  return {
    'Content-Security-Policy': cspFor(port),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), usb=(), payment=()',
  };
}

/**
 * The minimum `/healthz` must be able to say about itself.
 *
 * `redactionClamps` above zero means the redaction guard had to cut
 * something: it is not a condition to tolerate, it is a bug that has already
 * happened. It lives here and not only in the logs because a counter nobody
 * can read is not a check.
 */
export interface HealthStats {
  badLines: number;
  redactionClamps: number;
  /**
   * Lines rejected because they were inherited from another session's fork.
   *
   * It does not count toward `ok`: a high number means the filter is working,
   * not that something is broken. It lives here because it is the only way to
   * see whether it still works, the day forks change shape.
   */
  inheritedLines: number;
}

export interface HttpServerHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Whether a request names this server by a loopback name and its port.
 * Used for plain requests here and for the WebSocket upgrade in wsHub.ts,
 * which never reaches this handler.
 */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function createHttpServer(cfg: Config, stats: HealthStats): http.Server {
  const headers = securityHeaders(cfg.port);

  return http.createServer((req, res) => {
    // Anti DNS-rebinding: only a loopback Host, with the expected port.
    const host = req.headers.host ?? '';
    if (!isLoopbackHost(host, cfg.port)) {
      res.writeHead(421, headers).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: stats.redactionClamps === 0,
          v: 1,
          badLines: stats.badLines,
          redactionClamps: stats.redactionClamps,
          inheritedLines: stats.inheritedLines,
        }),
      );
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers).end();
      return;
    }

    serveStatic(url.pathname, res, headers);
  });
}

function serveStatic(pathname: string, res: http.ServerResponse, headers: Record<string, string>): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.resolve(CLIENT_DIR, rel);

  // no path traversal outside dist/client
  if (abs !== CLIENT_DIR && !abs.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403, headers).end();
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(abs);
    const isHashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(abs);
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(data);
  });
}

/** Listens ONLY on loopback. No --host flag: it cannot be gotten wrong. */
export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
