import type { ClientFrame, ServerFrame } from '../../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

export type LinkState = 'connecting' | 'on' | 'off';

const STORAGE_KEY = 'towerglow.token';
const MAX_BACKOFF_MS = 10_000;

/**
 * The token arrives in the URL the server prints (as Jupyter does) and is
 * remembered for the browser session, so reloading the page does not force
 * you to fetch the link from the terminal again.
 *
 * Deliberately NOT embedded in the served HTML: if it were, any local
 * process could read it with a GET and connect.
 */
export function resolveToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // private window or blocked storage: carry on without remembering
    }
    // The token disappears from the address bar, so it does not end up
    // in a screenshot or in a shared history.
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface SocketHandlers {
  onFrame: (frame: ServerFrame) => void;
  onState: (state: LinkState, detail?: string) => void;
}

export class Socket {
  #token: string;
  #handlers: SocketHandlers;
  #ws: WebSocket | null = null;
  #attempt = 0;
  #timer: number | null = null;
  #closed = false;

  constructor(token: string, handlers: SocketHandlers) {
    this.#token = token;
    this.#handlers = handlers;
  }

  connect(): void {
    if (this.#closed) return;
    this.#handlers.onState('connecting');

    const url = `ws://${location.host}/ws?t=${encodeURIComponent(this.#token)}`;
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#attempt = 0;
      this.#handlers.onState('on');
      this.send({ t: 'hello', v: PROTOCOL_VERSION });
    });

    ws.addEventListener('message', (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data as string) as ServerFrame;
      } catch {
        return;
      }
      this.#handlers.onFrame(frame);
    });

    ws.addEventListener('close', () => {
      this.#ws = null;
      if (this.#closed) return;
      this.#handlers.onState('off');
      this.#scheduleReconnect();
    });

    ws.addEventListener('error', () => ws.close());
  }

  #scheduleReconnect(): void {
    if (this.#timer !== null) return;
    const delay = Math.min(MAX_BACKOFF_MS, 400 * 2 ** this.#attempt++);
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.connect();
    }, delay);
  }

  send(frame: ClientFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#ws?.close();
  }
}
