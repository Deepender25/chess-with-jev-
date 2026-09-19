import { describe, it, expect } from 'vitest';
import { JevCircuitBreaker } from '../src/brain/circuitBreaker.js';
import { EvalCoalescer } from '../src/evalCoalescer.js';

describe('JevCircuitBreaker', () => {
  it('allows attempts while healthy', () => {
    const breaker = new JevCircuitBreaker(3, 60000);
    expect(breaker.canAttempt(1000)).toBe(true);
    expect(breaker.status(1000)).toEqual({ failures: 0, open: false, remainingMs: 0 });
  });

  it('stays closed below the failure threshold', () => {
    const breaker = new JevCircuitBreaker(3, 60000);
    breaker.recordFailure(1000);
    breaker.recordFailure(2000);
    expect(breaker.canAttempt(3000)).toBe(true);
    expect(breaker.status(3000).open).toBe(false);
  });

  it('opens after enough consecutive failures and closes again after the cooldown', () => {
    const breaker = new JevCircuitBreaker(3, 60000);
    breaker.recordFailure(1000);
    breaker.recordFailure(2000);
    breaker.recordFailure(3000);
    expect(breaker.canAttempt(3001)).toBe(false);
    expect(breaker.status(4000)).toEqual({ failures: 3, open: true, remainingMs: 59000 });
    // The cooldown opened at t=3000 and lasts 60000ms, so t=63000 is closed again.
    expect(breaker.canAttempt(63000)).toBe(true);
  });

  it('a success resets the failure streak entirely', () => {
    const breaker = new JevCircuitBreaker(3, 60000);
    breaker.recordFailure(1000);
    breaker.recordFailure(2000);
    breaker.recordSuccess();
    breaker.recordFailure(3000);
    breaker.recordFailure(4000);
    expect(breaker.canAttempt(5000)).toBe(true);
  });
});

describe('EvalCoalescer', () => {
  it('joins concurrent identical requests into one task', async () => {
    const coalescer = new EvalCoalescer<string>(5000);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'result';
    };

    const [a, b] = [coalescer.run('k', task), coalescer.run('k', task)];
    expect(await a).toBe('result');
    expect(await b).toBe('result');
    expect(runs).toBe(1);
  });

  it('serves a finished result from the cache within the TTL', async () => {
    const coalescer = new EvalCoalescer<string>(5000);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      return 'cached';
    };

    const t0 = Date.now();
    expect(await coalescer.run('k', task, t0)).toBe('cached');
    expect(await coalescer.run('k', task, t0 + 4000)).toBe('cached');
    expect(runs).toBe(1);
  });

  it('re-runs the task once the cached result has expired', async () => {
    const coalescer = new EvalCoalescer<string>(5000);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      return `run-${runs}`;
    };

    const t0 = Date.now();
    expect(await coalescer.run('k', task, t0)).toBe('run-1');
    expect(await coalescer.run('k', task, t0 + 5001)).toBe('run-2');
    expect(runs).toBe(2);
  });

  it('never caches a failure, so the next ask retries for real', async () => {
    const coalescer = new EvalCoalescer<string>(5000);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      if (runs === 1) throw new Error('upstream down');
      return 'recovered';
    };

    await expect(coalescer.run('k', task)).rejects.toThrow('upstream down');
    expect(await coalescer.run('k', task)).toBe('recovered');
    expect(runs).toBe(2);
  });

  it('keys different positions independently', async () => {
    const coalescer = new EvalCoalescer<string>(5000);
    let runs = 0;
    const runTask = async (tag: string): Promise<string> => {
      runs += 1;
      return tag;
    };

    const [a, b] = await Promise.all([
      coalescer.run('fenA', () => runTask('a')),
      coalescer.run('fenB', () => runTask('b'))
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(runs).toBe(2);
  });
});
