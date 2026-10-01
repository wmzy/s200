/**
 * Scheduler battery: a zero-dependency take on @nestjs/schedule — cron
 * expressions and fixed intervals on plain data and functions.
 *
 * `nextRun` is a pure 5-field cron matcher (minute hour day-of-month month
 * day-of-week) interpreted in **UTC**: every machine agrees on the absolute
 * instants, and the scheduler's re-arm chain only cares about epoch
 * milliseconds anyway. Supported field syntax: `*`, `a`, `a-b`, steps
 * (`*` or `a-b` with `/n`), and comma-joined mixes (`5,10-20/3,45`). No
 * day names, no `L`/
 * `W`/`#` extensions — whole-point matching only. Day-of-week runs 0-7 with
 * 0 and 7 both Sunday; when both day-of-month and day-of-week are restricted
 * (anything but a bare `*`), a date matches when EITHER does — the Vixie
 * cron rule.
 *
 * `createScheduler` runs its jobs on a `setTimeout` chain re-armed from each
 * job's next absolute occurrence, so ticks never accumulate drift — and
 * delays past the ~24.8-day timer ceiling are re-armed in chunks. Jobs are
 * concurrency-1: a tick landing while the previous run is still going is
 * skipped, not queued, and the next tick lands on the next grid point after
 * the run settles. A throwing or rejecting job is routed to `onError`
 * (default: `console.error`) without ever breaking the loop.
 *
 * @module
 */

/** A job body: sync or async; failures go to `onError`, never the caller. */
export type JobFn = () => void | Promise<void>;

/** Knobs for {@link createScheduler}. */
export type SchedulerOptions = {
  /** Epoch-millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Receives every thrown/rejected value plus the job's label — the cron
   * expression, or `interval:<ms>` for interval jobs. */
  onError?: (err: unknown, expr: string) => void;
};

/**
 * A running schedule: register `cron`/`interval` jobs, then `start` arms
 * them all; `stop` cancels every timer and waits for in-flight runs.
 */
export type Scheduler = {
  /** Registers a cron job (validated eagerly; unsatisfiable expressions
   * like `0 0 31 2 *` throw here). Registering on a running scheduler arms
   * the job immediately. */
  cron(expr: string, fn: JobFn): void;
  /** Registers a fixed-interval job; `ms` must be a positive finite number.
   * The first run lands `ms` after arming, later runs stay on that absolute
   * grid. Registering on a running scheduler arms the job immediately. */
  interval(ms: number, fn: JobFn): void;
  /** Arms every registered job. Throws if already started, or after a
   * `stop` (schedulers are single-use — create a new one). */
  start(): void;
  /** Cancels all timers, then resolves once the in-flight run (if any)
   * finished. A no-op on a never-started scheduler; idempotent. */
  stop(): Promise<void>;
};

/** One parsed cron field: its allowed values plus whether it was a bare `*`
 * (the flag behind the day-of-month/day-of-week OR rule). */
type CronField = { readonly values: Set<number>; readonly any: boolean };

/** A validated expression: allowed values per field, `expr` kept for errors. */
type ParsedCron = {
  readonly expr: string;
  readonly minutes: CronField;
  readonly hours: CronField;
  readonly days: CronField;
  readonly months: CronField;
  readonly dows: CronField;
};

type Timer = ReturnType<typeof setTimeout>;

type CronJob = {
  readonly kind: 'cron';
  readonly expr: string;
  readonly cron: ParsedCron;
  readonly fn: JobFn;
  next: number;
  timer: Timer | undefined;
  busy: Promise<void> | undefined;
};

type IntervalJob = {
  readonly kind: 'interval';
  readonly expr: string;
  readonly ms: number;
  readonly fn: JobFn;
  next: number;
  timer: Timer | undefined;
  busy: Promise<void> | undefined;
};

type Job = CronJob | IntervalJob;

/** `idle` = created, nothing armed; `stopped` = ran and was stopped. */
type SchedulerState = {
  phase: 'idle' | 'running' | 'stopped';
  readonly jobs: Job[];
  readonly now: () => number;
  readonly onError: (err: unknown, expr: string) => void;
};

// Any satisfiable expression recurs within the 400-year Gregorian cycle —
// the worst realistic search (rare dom/month/dow combos) stays well below
// this many month/day/hour jumps; anything longer never matches at all.
const SEARCH_CAP = 250_000;

// setTimeout delays are capped at 2^31-1 ms (~24.8 days); anything longer
// is re-armed in chunks of this size.
const MAX_DELAY = 2_147_483_000;

const FIELD_PART = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

function fail(expr: string, why: string): never {
  throw new Error(`Invalid cron expression "${expr}": ${why}`);
}

/**
 * Parses one field into its allowed values. `wrap7` folds day-of-week 7
 * onto Sunday (0); ranges must ascend; steps need a `*` or `a-b` base.
 */
function parseField(
  expr: string,
  text: string,
  name: string,
  min: number,
  max: number,
  wrap7: boolean
): CronField {
  const values = new Set<number>();
  const any = text === '*';
  for (const part of text.split(',')) {
    const match = FIELD_PART.exec(part);
    if (match === null) {
      fail(expr, `malformed ${name} field "${text}"`);
    }
    const base = match[1] ?? '';
    const top = match[2];
    const stepText = match[3];
    let lo: number;
    let hi: number;
    if (base === '*') {
      if (top !== undefined) {
        fail(expr, `range is not allowed on * in ${name} field "${text}"`);
      }
      lo = min;
      hi = max;
    } else {
      if (top === undefined && stepText !== undefined) {
        fail(expr, `step needs * or a-b, not a single value, in ${name} field "${text}"`);
      }
      lo = Number(base);
      hi = top === undefined ? lo : Number(top);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      fail(expr, `non-integer ${name} field "${text}"`);
    }
    if (lo < min || hi > max) {
      fail(expr, `${name} values must be ${min}-${max} in "${text}"`);
    }
    if (hi < lo) {
      fail(expr, `descending range in ${name} field "${text}"`);
    }
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        fail(expr, `step /${stepText} must be a positive integer in ${name} field "${text}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(wrap7 ? v % 7 : v);
    }
  }
  return { values, any };
}

function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    fail(expr, `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const [minute = '', hour = '', day = '', month = '', dow = ''] = fields;
  return {
    expr,
    minutes: parseField(expr, minute, 'minute', 0, 59, false),
    hours: parseField(expr, hour, 'hour', 0, 23, false),
    days: parseField(expr, day, 'day-of-month', 1, 31, false),
    months: parseField(expr, month, 'month', 1, 12, false),
    dows: parseField(expr, dow, 'day-of-week', 0, 7, true),
  };
}

/**
 * The Vixie day rule: a bare `*` on either day field leaves the other in
 * charge; two restricted fields match on EITHER — `0 0 1 * 1` fires on
 * every 1st AND every Monday.
 */
function dayMatches(cron: ParsedCron, at: Date): boolean {
  const domOk = cron.days.values.has(at.getUTCDate());
  const dowOk = cron.dows.values.has(at.getUTCDay());
  if (cron.days.any) {
    return cron.dows.any ? true : dowOk;
  }
  return cron.dows.any ? domOk : domOk || dowOk;
}

/**
 * The next matching epoch millisecond strictly after `from`, by stepping
 * minute → hour → day → month candidates (never brute-forcing whole days).
 * Throws when the expression can never match (`0 0 31 2 *`).
 */
function nextAfter(cron: ParsedCron, from: number): number {
  // Matches live on minute boundaries: start at the first one after `from`.
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < SEARCH_CAP; i += 1) {
    const at = new Date(t);
    if (!cron.months.values.has(at.getUTCMonth() + 1)) {
      t = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(cron, at)) {
      t = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
      continue;
    }
    if (!cron.hours.values.has(at.getUTCHours())) {
      t += (60 - at.getUTCMinutes()) * 60_000;
      continue;
    }
    if (!cron.minutes.values.has(at.getUTCMinutes())) {
      t += 60_000;
      continue;
    }
    return t;
  }
  fail(cron.expr, 'this expression never matches — no day/month combination it allows exists');
}

/**
 * Next run of a 5-field cron expression, as the instant strictly after
 * `from` (a `from` that is itself a match yields the following one). Fields
 * are UTC and support `*`, `a`, `a-b`, steps (`/n` on `*` or a range),
 * comma mixes; throws
 * `Error` carrying the original expression on any malformed or unsatisfiable
 * input.
 */
export function nextRun(expr: string, from: Date): Date {
  return new Date(nextAfter(parseCron(expr), from.getTime()));
}

/**
 * Runs `fn`, routing any throw/rejection to `onError` — the returned promise
 * always resolves, so the scheduling loop cannot be taken down by a job.
 */
function run(state: SchedulerState, job: Job): Promise<void> {
  return (async () => {
    try {
      await job.fn();
    } catch (err) {
      state.onError(err, job.expr);
    }
  })();
}

/** Arms `job` at its absolute `next` target, chunking delays past the
 * ~24.8-day setTimeout ceiling (each chunk re-enters with the remaining
 * delay recomputed from the clock). */
function arm(state: SchedulerState, job: Job): void {
  if (state.phase !== 'running') {
    return;
  }
  const delay = job.next - state.now();
  job.timer =
    delay > MAX_DELAY
      ? setTimeout(() => arm(state, job), MAX_DELAY)
      : setTimeout(() => tick(state, job), Math.max(0, delay));
}

/** A timer firing: runs the job unless the previous run is still going —
 * skipped ticks are not queued; the running job's own completion re-arms. */
function tick(state: SchedulerState, job: Job): void {
  job.timer = undefined;
  if (state.phase !== 'running' || job.busy !== undefined) {
    return;
  }
  job.busy = run(state, job);
  job.busy.then(() => {
    job.busy = undefined;
    scheduleNext(state, job);
  });
}

/** Computes the job's next absolute occurrence and arms it. Both branches
 * advance strictly past the point just fired AND the clock: Node timers run
 * on a monotonic clock that can sit ~1ms off the wall clock, and a fire
 * landing "early" must not re-arm onto the point it just consumed (a daily
 * job would run twice). Interval jobs stay on their original grid — whole
 * `ms` steps, skipping every tick missed while busy, never replaying. */
function scheduleNext(state: SchedulerState, job: Job): void {
  if (state.phase !== 'running') {
    return;
  }
  if (job.kind === 'cron') {
    job.next = nextAfter(job.cron, Math.max(state.now(), job.next));
  } else {
    const past = Math.max(state.now(), job.next);
    job.next += (Math.floor((past - job.next) / job.ms) + 1) * job.ms;
  }
  arm(state, job);
}

/** First arming of a job: cron starts at its next occurrence, intervals at
 * `now + ms` — the grid every later tick stays on. */
function launch(state: SchedulerState, job: Job): void {
  job.next =
    job.kind === 'cron' ? nextAfter(job.cron, state.now()) : state.now() + job.ms;
  arm(state, job);
}

/**
 * Builds a scheduler: register `cron`/`interval` jobs, then `start()` arms
 * them; `stop()` cancels every timer and resolves after in-flight runs.
 * Timers re-arm from absolute targets (no drift), a job runs at most once
 * at a time (late ticks are skipped, never queued), and job failures go to
 * `options.onError` — default `console.error` — without stopping the loop.
 * `stop()` on a never-started scheduler is a no-op; a stopped scheduler
 * rejects `start` and further registrations (create a new one instead).
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const state: SchedulerState = {
    phase: 'idle',
    jobs: [],
    now: options.now ?? Date.now,
    onError:
      options.onError ??
      ((err: unknown, expr: string): void => {
        console.error(`scheduled job ${expr} failed:`, err);
      }),
  };
  function cron(expr: string, fn: JobFn): void {
    if (state.phase === 'stopped') {
      throw new Error('Cannot register a cron job on a stopped scheduler');
    }
    const parsed = parseCron(expr);
    // Eager probe: a parseable-but-unsatisfiable expression (`0 0 31 2 *`)
    // fails here at registration, not later at start.
    nextAfter(parsed, state.now());
    const job: CronJob = {
      kind: 'cron',
      expr,
      cron: parsed,
      fn,
      next: 0,
      timer: undefined,
      busy: undefined,
    };
    state.jobs.push(job);
    if (state.phase === 'running') {
      launch(state, job);
    }
  }
  function interval(ms: number, fn: JobFn): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`Invalid interval ${String(ms)}ms: must be positive`);
    }
    if (state.phase === 'stopped') {
      throw new Error('Cannot register an interval job on a stopped scheduler');
    }
    const job: IntervalJob = {
      kind: 'interval',
      expr: `interval:${String(ms)}`,
      ms,
      fn,
      next: 0,
      timer: undefined,
      busy: undefined,
    };
    state.jobs.push(job);
    if (state.phase === 'running') {
      launch(state, job);
    }
  }
  function start(): void {
    if (state.phase === 'running') {
      throw new Error('Scheduler already started');
    }
    if (state.phase === 'stopped') {
      throw new Error('Scheduler already stopped — create a new one instead');
    }
    state.phase = 'running';
    for (const job of state.jobs) {
      launch(state, job);
    }
  }
  async function stop(): Promise<void> {
    if (state.phase !== 'running') {
      return;
    }
    const busy = state.jobs.flatMap((job) => (job.busy === undefined ? [] : [job.busy]));
    for (const job of state.jobs) {
      if (job.timer !== undefined) {
        clearTimeout(job.timer);
      }
      job.timer = undefined;
    }
    state.phase = 'stopped';
    await Promise.all(busy);
  }
  return { cron, interval, start, stop };
}
