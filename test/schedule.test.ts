import { describe, it, vi } from 'vitest';

import { createScheduler, nextRun } from '../src/schedule';

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

function at(date: Date): string {
  return date.toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('poll timeout');
    }
    await sleep(5);
  }
}

function badCron(expr: string): string {
  try {
    nextRun(expr, utc(2026, 1, 1));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected "${expr}" to be rejected`);
}

describe('nextRun', () => {
  it('steps to the next matching minute', () => {
    at(nextRun('*/15 * * * *', utc(2026, 1, 1, 10, 7))).should.equal('2026-01-01T10:15:00.000Z');
    at(nextRun('30 2 * * *', utc(2026, 1, 1, 3, 0))).should.equal('2026-01-02T02:30:00.000Z');
    at(nextRun('0 * * * *', utc(2026, 1, 1, 10, 59))).should.equal('2026-01-01T11:00:00.000Z');
  });

  it('is strictly after `from`, even when from is itself a match', () => {
    at(nextRun('*/15 * * * *', utc(2026, 1, 1, 10, 15))).should.equal('2026-01-01T10:30:00.000Z');
    at(nextRun('*/15 * * * *', utc(2026, 1, 1, 10, 15, 30))).should.equal('2026-01-01T10:30:00.000Z');
  });

  it('rolls through months and years', () => {
    at(nextRun('0 0 1 * *', utc(2026, 1, 31))).should.equal('2026-02-01T00:00:00.000Z');
    // No 31st in February (or April/June/September/November): Jan 31 → Mar 31.
    at(nextRun('0 0 31 * *', utc(2026, 1, 31))).should.equal('2026-03-31T00:00:00.000Z');
    at(nextRun('0 0 1 1 *', utc(2026, 12, 31, 23, 59))).should.equal('2027-01-01T00:00:00.000Z');
    at(nextRun('0 0 1 */2 *', utc(2026, 3, 2))).should.equal('2026-05-01T00:00:00.000Z');
  });

  it('finds leap day only in leap years', () => {
    at(nextRun('0 0 29 2 *', utc(2026, 2, 28))).should.equal('2028-02-29T00:00:00.000Z');
  });

  it('steps within ranges and wraps to the next hour', () => {
    // 10-40/15 → minutes 10, 25, 40.
    at(nextRun('10-40/15 * * * *', utc(2026, 1, 1, 10, 0))).should.equal('2026-01-01T10:10:00.000Z');
    at(nextRun('10-40/15 * * * *', utc(2026, 1, 1, 10, 26))).should.equal('2026-01-01T10:40:00.000Z');
    at(nextRun('10-40/15 * * * *', utc(2026, 1, 1, 10, 41))).should.equal('2026-01-01T11:10:00.000Z');
  });

  it('mixes comma-joined parts', () => {
    at(nextRun('5,20-25/5,45 * * * *', utc(2026, 1, 1, 10, 6))).should.equal('2026-01-01T10:20:00.000Z');
    at(nextRun('5,20-25/5,45 * * * *', utc(2026, 1, 1, 10, 26))).should.equal('2026-01-01T10:45:00.000Z');
  });

  it('matches day-of-week with 0 and 7 both Sunday', () => {
    // 2026-10-01 is a Thursday.
    at(nextRun('0 12 * * 1', utc(2026, 10, 1))).should.equal('2026-10-05T12:00:00.000Z');
    at(nextRun('0 12 * * 0', utc(2026, 10, 1))).should.equal('2026-10-04T12:00:00.000Z');
    at(nextRun('0 12 * * 7', utc(2026, 10, 1))).should.equal('2026-10-04T12:00:00.000Z');
    at(nextRun('0 0 * * 1-5', utc(2026, 10, 2))).should.equal('2026-10-05T00:00:00.000Z');
    // 5-7 wraps 7 onto Sunday: from Sat Oct 3, a 5-7 schedule hits Sun Oct 4.
    at(nextRun('0 0 * * 5-7', utc(2026, 10, 3))).should.equal('2026-10-04T00:00:00.000Z');
  });

  it('ORs day-of-month with day-of-week when both are restricted (Vixie rule)', () => {
    // 2026-09-25 is a Friday, Sep 28 the following Monday, Oct 1 a Thursday.
    at(nextRun('0 0 1 * 1', utc(2026, 9, 25))).should.equal('2026-09-28T00:00:00.000Z');
    at(nextRun('0 0 * * 1', utc(2026, 9, 25))).should.equal('2026-09-28T00:00:00.000Z');
    at(nextRun('0 0 1 * *', utc(2026, 9, 25))).should.equal('2026-10-01T00:00:00.000Z');
  });

  it('rejects malformed expressions, quoting the original text', () => {
    badCron('* * * *').should.include('got 4');
    badCron('* * * * * *').should.include('got 6');
    badCron('60 * * * *').should.include('minute');
    badCron('* 24 * * *').should.include('hour');
    badCron('* * 0 * *').should.include('day-of-month');
    badCron('* * * 13 *').should.include('month');
    badCron('* * * * 8').should.include('day-of-week');
    badCron('50-10 * * * *').should.include('descending range');
    badCron('*/0 * * * *').should.include('step');
    badCron('5/2 * * * *').should.include('step needs * or a-b');
    badCron('*-5 * * * *').should.include('range is not allowed on *');
    badCron('a * * * *').should.include('"a * * * *"');
    badCron('1,,2 * * * *').should.include('"1,,2 * * * *"');
    badCron('1-2-3 * * * *').should.include('"1-2-3 * * * *"');
  });

  it('throws on day/month combinations that never exist', () => {
    badCron('0 0 31 2 *').should.include('0 0 31 2 *');
    badCron('0 0 31 2 *').should.include('never match');
    badCron('0 0 31 4,6,9,11 *').should.include('never match');
  });
});

describe('createScheduler', () => {
  it('fires interval jobs on the absolute grid, without drift', async () => {
    const scheduler = createScheduler();
    const fired: number[] = [];
    scheduler.interval(15, () => {
      fired.push(Date.now());
    });
    const start = Date.now();
    scheduler.start();
    await until(() => fired.length >= 4);
    await scheduler.stop();
    // Grid points 15/30/45/60ms after arming: a fire may sit ~1ms off its
    // grid (timer clock vs wall clock) but the grid itself never drifts.
    (fired[3]! >= start + 55).should.equal(true);
    (fired[3]! <= start + 1000).should.equal(true);
  });

  it('stops firing after stop() cancels the timers', async () => {
    const scheduler = createScheduler();
    let calls = 0;
    scheduler.interval(10, () => {
      calls += 1;
    });
    scheduler.start();
    await until(() => calls >= 2);
    await scheduler.stop();
    const after = calls;
    await sleep(60); // six grid points would have fired
    calls.should.equal(after);
  });

  it('skips ticks while the previous run is still going (concurrency 1, no queue)', async () => {
    const scheduler = createScheduler();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.interval(12, () => {
      calls += 1;
      return gate;
    });
    scheduler.start();
    await until(() => calls === 1);
    await sleep(45); // at least three grid points pass while the run blocks
    calls.should.equal(1); // skipped, not queued
    release();
    await until(() => calls === 2); // the loop recovers on the next grid point
    await scheduler.stop();
  }, 8000);

  it('routes sync throws and async rejections to onError, and keeps looping', async () => {
    const seen: { err: unknown; expr: string }[] = [];
    const scheduler = createScheduler({
      onError: (err, expr) => {
        seen.push({ err, expr });
      },
    });
    let calls = 0;
    scheduler.interval(10, () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('sync boom');
      }
      if (calls === 2) {
        return Promise.reject(new Error('async boom'));
      }
    });
    scheduler.start();
    await until(() => calls >= 4);
    await scheduler.stop();
    seen.length.should.equal(2);
    (seen[0]!.err as Error).message.should.equal('sync boom');
    (seen[1]!.err as Error).message.should.equal('async boom');
    seen[0]!.expr.should.equal('interval:10');
  });

  it('defaults to console.error without breaking the loop', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const scheduler = createScheduler();
      let calls = 0;
      scheduler.interval(10, () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('default boom');
        }
      });
      scheduler.start();
      await until(() => calls >= 3);
      await scheduler.stop();
      errors.mock.calls.length.should.equal(1);
      (errors.mock.calls[0] ?? []).join(' ').should.include('default boom');
      (errors.mock.calls[0] ?? []).join(' ').should.include('interval:10');
    } finally {
      errors.mockRestore();
    }
  });

  it('awaits an in-flight job before stop() resolves', async () => {
    const scheduler = createScheduler();
    let started = false;
    let done = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.interval(10, () => {
      started = true;
      return gate.then(() => {
        done = true;
      });
    });
    scheduler.start();
    await until(() => started);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    stopped.should.equal(false); // still waiting on the gated job
    release();
    await stopping;
    stopped.should.equal(true);
    done.should.equal(true);
  }, 8000);

  it('arms jobs registered after start, and defines phase semantics', async () => {
    const scheduler = createScheduler();
    await scheduler.stop(); // never started: no-op, start stays allowed
    let calls = 0;
    scheduler.start();
    scheduler.interval(10, () => {
      calls += 1;
    }); // registered while running: armed immediately
    await until(() => calls >= 2);
    (() => scheduler.start()).should.throw(/already started/);
    await scheduler.stop();
    (() => scheduler.start()).should.throw(/stopped/);
    (() => scheduler.interval(10, () => undefined)).should.throw(/stopped/);
    (() => scheduler.cron('* * * * *', () => undefined)).should.throw(/stopped/);
    await scheduler.stop(); // idempotent
  }, 8000);

  it('validates expressions and intervals at registration', () => {
    const scheduler = createScheduler();
    (() => scheduler.interval(0, () => undefined)).should.throw(/must be positive/);
    (() => scheduler.interval(Number.NaN, () => undefined)).should.throw(/must be positive/);
    (() => scheduler.cron('nope', () => undefined)).should.throw(/nope/);
    (() => scheduler.cron('0 0 31 2 *', () => undefined)).should.throw(/never match/);
  });
});

describe('createScheduler (fake clock)', () => {
  // Date is faked too, so the scheduler's clock reads exactly the instant a
  // timer fires at — mock timers and injected clock advance in lockstep.
  const FAKE: { toFake: ('setTimeout' | 'clearTimeout' | 'Date')[] } = {
    toFake: ['setTimeout', 'clearTimeout', 'Date'],
  };

  it('hits cron targets exactly, once per boundary, from the injected clock', async () => {
    vi.useFakeTimers(FAKE);
    try {
      vi.setSystemTime(utc(2026, 10, 1, 10, 30, 0));
      const scheduler = createScheduler({ now: () => Date.now() });
      let calls = 0;
      scheduler.cron('*/15 * * * *', () => {
        calls += 1;
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
      calls.should.equal(0); // one second short of 10:45
      await vi.advanceTimersByTimeAsync(1_500);
      calls.should.equal(1);
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      calls.should.equal(4); // 10:45, 11:00, 11:15, 11:30
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps interval ticks on the absolute grid and skips missed ones', async () => {
    vi.useFakeTimers(FAKE);
    try {
      vi.setSystemTime(utc(2026, 10, 1));
      const scheduler = createScheduler({ now: () => Date.now() });
      let calls = 0;
      scheduler.interval(10, () => {
        calls += 1;
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(35);
      calls.should.equal(3); // ticks at 10, 20, 30 — never a burst

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = createScheduler({ now: () => Date.now() });
      let gated = 0;
      blocked.interval(10, () => {
        gated += 1;
        return gate;
      });
      blocked.start();
      await vi.advanceTimersByTimeAsync(35); // tick at +10 runs & blocks; +20, +30 skip
      gated.should.equal(1);
      release();
      await vi.advanceTimersByTimeAsync(24); // now at fake-time 94
      gated.should.equal(3); // grid points 75 and 85 — back on the grid, no replay
      await scheduler.stop();
      await blocked.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms in chunks when the next run outlives the setTimeout ceiling', async () => {
    vi.useFakeTimers(FAKE);
    try {
      vi.setSystemTime(utc(2026, 10, 1)); // 92 days before 2027-01-01
      const scheduler = createScheduler({ now: () => Date.now() });
      let calls = 0;
      scheduler.cron('0 0 1 1 *', () => {
        calls += 1;
      });
      scheduler.start();
      // The raw delay (~92 days) exceeds the ~24.8-day (2^31 ms) timer cap;
      // the scheduler must survive by re-arming in chunks.
      await vi.advanceTimersByTimeAsync(3 * 2 ** 31); // ~74.6 days: not there yet
      calls.should.equal(0);
      await vi.advanceTimersByTimeAsync(20 * 86_400_000); // crosses Jan 1
      calls.should.equal(1);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
