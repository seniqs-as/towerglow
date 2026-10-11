import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CHUNK = 1 << 20; // 1 MiB per pass: does not saturate the event loop
const MAX_CARRY = 8 * 1024 * 1024;

/**
 * Incremental tail of an append-only file.
 *
 * It closes the three classic bugs of this kind of code:
 *  1. partial line straddling two reads -> the remainder is kept (`carry`)
 *  2. UTF-8 character split mid-chunk -> StringDecoder, NEVER buf.toString()
 *  3. file truncated or rotated -> if the size shrinks, restart from the tail
 *
 * It is needed because transcripts reach tens of MB: reading them whole
 * would stall everything and eat memory on every update.
 */
export class Tailer {
  #path: string;
  #onLine: (line: string) => void;
  #warmupBytes: number;
  /** Injectable for tests: it is the only way to force a chunk boundary. */
  #chunk: number;

  #fh: FileHandle | null = null;
  #offset = 0;
  #carry = '';
  #decoder = new StringDecoder('utf8');
  #skipPartialFirstLine = false;
  #pumping = false;
  #closed = false;

  constructor(
    path: string,
    warmupBytes: number,
    onLine: (line: string) => void,
    chunkSize = DEFAULT_CHUNK,
  ) {
    this.#path = path;
    this.#warmupBytes = warmupBytes;
    this.#onLine = onLine;
    this.#chunk = Math.max(1, chunkSize);
  }

  get offset(): number {
    return this.#offset;
  }

  async open(): Promise<void> {
    this.#fh = await open(this.#path, 'r');
    const st = await this.#fh.stat();
    // Start from the tail: the scene fills with recent activity without
    // re-reading tens of MB of history.
    //
    // The window must be chosen by measurement, not by eye: with 256 KiB on a
    // 10 MB transcript ZERO tool_use/tool_result pairs were recovered, so
    // after a restart the city forgot which files had been touched. With
    // 8 MiB about twenty are recovered, at a one-off cost of ~80 ms per
    // session -- measured, not estimated.
    this.#offset = Math.max(0, st.size - this.#warmupBytes);
    // Starting mid-file the first line read is almost always truncated and
    // must be dropped. But with warmupBytes = 0 we start at END of file, which
    // is already a line boundary: dropping there would mean losing the first
    // event after startup, which is exactly the one that matters most.
    this.#skipPartialFirstLine = this.#warmupBytes > 0 && this.#offset > 0;
    await this.pump();
  }

  async pump(): Promise<void> {
    if (this.#pumping || this.#closed || !this.#fh) return;
    this.#pumping = true;
    try {
      for (;;) {
        /*
         * The handle is held here, and `closed` is asked again after every
         * await: `close()` nulls `#fh` while a pass waits on `stat`, and the
         * pass woke up to read from null. Measured on 2026-09-29: the rejection
         * went unhandled and took the whole server down at startup.
         */
        const fh = this.#fh;
        if (this.#closed || !fh) return;
        const st = await fh.stat();
        if (this.#closed) return;

        if (st.size < this.#offset) {
          // truncated or rotated: restart from the tail with the state reset
          this.#offset = Math.max(0, st.size - this.#warmupBytes);
          this.#carry = '';
          this.#decoder = new StringDecoder('utf8');
          this.#skipPartialFirstLine = this.#warmupBytes > 0 && this.#offset > 0;
        }
        if (st.size === this.#offset) return;

        const len = Math.min(st.size - this.#offset, this.#chunk);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.#offset);
        if (bytesRead === 0 || this.#closed) return;
        this.#offset += bytesRead;

        const text = this.#carry + this.#decoder.write(buf.subarray(0, bytesRead));
        const parts = text.split('\n');
        this.#carry = parts.pop() ?? '';

        for (const line of parts) {
          if (this.#skipPartialFirstLine) {
            this.#skipPartialFirstLine = false;
            continue;
          }
          if (line.length === 0) continue;
          this.#onLine(line);
        }

        // Anti-OOM guard: a line with no newline cannot grow forever.
        if (this.#carry.length > MAX_CARRY) this.#carry = '';
      }
    } finally {
      this.#pumping = false;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const fh = this.#fh;
    this.#fh = null;
    await fh?.close();
  }
}
