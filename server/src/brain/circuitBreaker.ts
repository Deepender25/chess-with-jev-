/**
 * A minimal circuit breaker for the Jev request.
 *
 * When the upstream model is unhealthy, every evaluation pays the full request
 * timeout before falling back to the engine. After a few consecutive failures
 * it is cheaper and no less correct to skip Jev outright for a while and answer
 * engine-only (which is always safe) until the breaker's cooldown expires and
 * Jev is probed again.
 *
 * `now` is injectable so the behaviour is testable without fake timers.
 */
export class JevCircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number
  ) {}

  /** True when a Jev request may be attempted at the given time. */
  public canAttempt(now: number = Date.now()): boolean {
    return now >= this.openUntil;
  }

  public recordFailure(now: number = Date.now()): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }

  /** A success means the upstream recovered: forget the streak entirely. */
  public recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  public status(now: number = Date.now()): {
    failures: number;
    open: boolean;
    remainingMs: number;
  } {
    const open = now < this.openUntil;
    return {
      failures: this.failures,
      open,
      remainingMs: open ? this.openUntil - now : 0
    };
  }
}
