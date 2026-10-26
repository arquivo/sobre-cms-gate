// Fixed-window counters per key (an address or a GitHub login), in memory: one process serves the CMS.

const SWEEP_AT = 10_000;

export class RateLimit {
  readonly #windowMs: number;
  readonly #max: number;
  readonly #windows = new Map<string, { start: number; used: number }>();

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /** What is left of the key's budget in the current window. */
  remaining(key: string): number {
    const w = this.#window(key);
    return this.#max - w.used;
  }

  /** Seconds until the key's window resets. */
  retryAfter(key: string): number {
    return Math.max(1, Math.ceil((this.#window(key).start + this.#windowMs - Date.now()) / 1000));
  }

  /** Takes `amount` from the key's budget if it fits; false (and nothing taken) if it doesn't. */
  take(key: string, amount = 1): boolean {
    const w = this.#window(key);
    if (w.used + amount > this.#max) return false;
    w.used += amount;
    return true;
  }

  #window(key: string) {
    const now = Date.now();
    let w = this.#windows.get(key);
    if (!w || now - w.start >= this.#windowMs) {
      if (this.#windows.size >= SWEEP_AT) {
        for (const [k, v] of this.#windows) if (now - v.start >= this.#windowMs) this.#windows.delete(k);
      }
      w = { start: now, used: 0 };
      this.#windows.set(key, w);
    }
    return w;
  }
}
