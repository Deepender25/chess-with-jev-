/**
 * Deduplicates expensive evaluations by key.
 *
 * While a task is in flight, every identical `run` joins the same promise
 * instead of starting a second evaluation. A finished result is served from
 * the cache for `ttlMs`, so a client that recovers from a stuck state and
 * re-asks for a position it just asked about does not re-pay the work. Failed
 * evaluations are never cached: the next ask retries for real.
 *
 * `now` is injectable so cache expiry is testable without fake timers.
 */
interface CoalescerEntry<T> {
  promise: Promise<T>;
  result?: T;
  settled: boolean;
  expiresAt: number;
}

export class EvalCoalescer<T> {
  private readonly entries = new Map<string, CoalescerEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  public run(key: string, task: () => Promise<T>, now: number = Date.now()): Promise<T> {
    this.sweep(now);

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.settled && now < existing.expiresAt) {
        return Promise.resolve(existing.result as T);
      }
      if (!existing.settled) {
        // Still in flight: join it.
        return existing.promise;
      }
      this.entries.delete(key);
    }

    const entry: CoalescerEntry<T> = {
      promise: undefined as unknown as Promise<T>,
      settled: false,
      expiresAt: 0
    };
    entry.promise = task().then(
      (result) => {
        entry.result = result;
        entry.settled = true;
        entry.expiresAt = now + this.ttlMs;
        return result;
      },
      (error) => {
        this.entries.delete(key);
        throw error;
      }
    );
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** Entries currently tracked (expired ones are swept first). */
  public size(now: number = Date.now()): number {
    this.sweep(now);
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.settled && now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }
}
