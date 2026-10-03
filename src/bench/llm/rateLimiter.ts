const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Spaces calls at least `intervalMs` apart. Shared by every client of one
 * provider, so two models on the same provider (or two seats using the same
 * model) together stay under that provider's requests-per-minute limit.
 */
export class MinIntervalLimiter {
  readonly intervalMs: number;
  private nextSlot = 0;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Resolves when it is this caller's turn; returns how long it had to wait (ms). */
  async acquire(): Promise<number> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.intervalMs;
    const wait = start - now;
    if (wait > 0) await sleep(wait);
    return wait;
  }
}
