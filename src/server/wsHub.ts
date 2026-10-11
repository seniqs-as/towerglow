import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Caps, ClientFrame, DeltaEvent, ServerFrame, Snapshot } from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { isLoopbackHost } from './httpServer.ts';

const BATCH_MS = 100;
const MAX_BUFFERED = 4 * 1024 * 1024;
/** Events that can be sacrificed when the client can't keep up. */
const LOW_PRIORITY = new Set<DeltaEvent['t']>(['usage', 'tool.burst', 'context']);

export interface WsHubOptions {
  server: http.Server;
  port: number;
  token: string;
  /** Evaluated at every connection, not once: the CEOs come up after listening starts. */
  caps: () => Caps;
  devOrigins?: readonly string[];
  snapshot: () => Snapshot;
  onClientFrame?: (frame: ClientFrame, reply: (f: ServerFrame) => void) => void;
  /**
   * Run on every event on its way out: the redaction net (`assertSafe` in
   * development, `clampUnsafe` otherwise). Here and not at each source,
   * because the sources were many and some of them had been left out.
   */
  guard?: (event: DeltaEvent) => void;
}

interface Client {
  socket: WebSocket;
  queue: DeltaEvent[];
  dropped: number;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class WsHub {
  #wss: WebSocketServer;
  #opts: WsHubOptions;
  #clients = new Set<Client>();
  #seq = 0;
  #timer: NodeJS.Timeout;
  #snapshotCache: { version: number; json: string } | null = null;

  constructor(opts: WsHubOptions) {
    this.#opts = opts;
    this.#wss = new WebSocketServer({ noServer: true });

    opts.server.on('upgrade', (req, socket, head) => {
      if (!this.#authorize(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
    });

    this.#timer = setInterval(() => this.#flush(), BATCH_MS);
    this.#timer.unref?.();
  }

  #authorize(req: http.IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') return false;
    // The upgrade never reaches the HTTP handler, so its Host check is made
    // again here. Origin and token already refuse a rebound page; this keeps
    // "every request names a loopback host" true for the WebSocket as well.
    if (!isLoopbackHost(req.headers.host, this.#opts.port)) return false;

    const allowedOrigins = [
      `http://127.0.0.1:${this.#opts.port}`,
      `http://localhost:${this.#opts.port}`,
      ...(this.#opts.devOrigins ?? []),
    ];
    const origin = req.headers.origin;
    // A non-browser client sends no Origin: that is acceptable, the token stays mandatory.
    if (origin !== undefined && !allowedOrigins.includes(origin)) return false;

    return timingSafeEqual(url.searchParams.get('t') ?? '', this.#opts.token);
  }

  #accept(socket: WebSocket): void {
    const client: Client = { socket, queue: [], dropped: 0 };
    this.#clients.add(client);

    send(socket, {
      t: 'hello',
      v: PROTOCOL_VERSION,
      serverTime: Date.now(),
      caps: this.#opts.caps(),
    });
    socket.send(this.#snapshotJson());

    socket.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        return; // malformed payload: ignored, never a throw
      }
      if (frame.t === 'hello' && frame.v !== PROTOCOL_VERSION) {
        send(socket, { t: 'error', code: 'version_mismatch', detail: `server v${PROTOCOL_VERSION}` });
        socket.close();
        return;
      }
      if (frame.t === 'resync') {
        socket.send(this.#snapshotJson());
        return;
      }
      this.#opts.onClientFrame?.(frame, (f) => send(socket, f));
    });

    socket.on('close', () => this.#clients.delete(client));
    socket.on('error', () => this.#clients.delete(client));
  }

  /** The serialized, cached snapshot: N reconnecting clients don't recompute it N times. */
  #snapshotJson(): string {
    const snap = this.#opts.snapshot();
    const version = snap.projects.length + snap.sessions.length + snap.agents.length + snap.at;
    if (this.#snapshotCache && this.#snapshotCache.version === version) return this.#snapshotCache.json;
    const json = JSON.stringify({ t: 'snapshot', ...snap } satisfies ServerFrame);
    this.#snapshotCache = { version, json };
    return json;
  }

  broadcast(events: readonly DeltaEvent[]): void {
    if (events.length === 0) return;
    if (this.#opts.guard) for (const ev of events) this.#opts.guard(ev);
    this.#snapshotCache = null;
    for (const client of this.#clients) {
      for (const ev of events) client.queue.push(ev);
    }
  }

  #flush(): void {
    for (const client of this.#clients) {
      if (client.queue.length === 0) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;

      let events = client.queue;
      client.queue = [];

      // Backpressure: incidental events are sacrificed first, not births and deaths.
      if (client.socket.bufferedAmount > MAX_BUFFERED) {
        const kept = events.filter((e) => !LOW_PRIORITY.has(e.t));
        client.dropped += events.length - kept.length;
        events = kept;
        if (events.length === 0) continue;
      }

      send(client.socket, { t: 'batch', at: Date.now(), seq: ++this.#seq, events });
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const c of this.#clients) c.socket.close();
    this.#clients.clear();
    this.#wss.close();
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
