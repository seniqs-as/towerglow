/** Fixed-size circular buffer: the snapshot carries the latest events, not all of them. */
export class RingBuffer<T> {
  #items: (T | undefined)[];
  #next = 0;
  #size = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('capacity must be at least 1');
    this.#items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.#items.length;
    if (this.#size < this.#items.length) this.#size++;
  }

  /** From oldest to most recent. */
  toArray(): T[] {
    const out: T[] = [];
    const cap = this.#items.length;
    const start = (this.#next - this.#size + cap) % cap;
    for (let i = 0; i < this.#size; i++) {
      const item = this.#items[(start + i) % cap];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  get length(): number {
    return this.#size;
  }

  clear(): void {
    this.#items = new Array<T | undefined>(this.#items.length);
    this.#next = 0;
    this.#size = 0;
  }
}
