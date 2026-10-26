import { describe, it } from 'vitest';

import { createApp, get, handle } from '../src/app';
import {
  breakerCall,
  canPass,
  circuitStatus,
  createCircuitBreaker,
  recordFailure,
  recordSuccess,
  skipClientErrors,
} from '../src/circuit-breaker';
import { httpError, isHttpError, type HttpError } from '../src/errors';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// vitest's should chain has no chai-as-promised plugins (no `rejectedWith`),
// so capture rejections manually and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

/** A fresh upstream-failure value — for recordFailure's error argument. */
function deadError(): Error {
  return new Error('upstream dead');
}

/** A call that always fails — for breakerCall's wrapped fn. */
function boom(): never {
  throw deadError();
}

describe('circuitBreaker state machine', function () {
  it('trips open at the failure threshold inside the window', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      windowMs: 1000,
      cooldownMs: 5000,
      now: time.now,
    });
    canPass(breaker).should.be.true;
    recordFailure(breaker, deadError());
    recordFailure(breaker, deadError());
    circuitStatus(breaker).phase.should.equal('closed');
    recordFailure(breaker, deadError());
    circuitStatus(breaker).phase.should.equal('open');
    canPass(breaker).should.be.false;
  });

  it('ages failures out of the window — old failures never trip it', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      windowMs: 1000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    time.advance(1000); // first failure exactly at the cutoff expires
    recordFailure(breaker, deadError());
    circuitStatus(breaker).phase.should.equal('closed');
    recordFailure(breaker, deadError()); // two live failures now
    circuitStatus(breaker).phase.should.equal('open');
  });

  it('rejects calls while open: 503 HttpError with Retry-After, fn never runs', async function () {
    const time = clock(1000);
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 30_000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    let ran = 0;
    const rejected = (await rejectionOf(
      breakerCall(breaker, () => {
        ran += 1;
        return 'ok';
      })
    )) as HttpError;
    isHttpError(rejected).should.be.true;
    rejected.status.should.equal(503);
    (rejected.headers?.['retry-after'] ?? '').should.equal('30');
    (rejected.body as { error?: string }).should.deep.equal({
      error: 'Service Unavailable',
    });
    ran.should.equal(0);
  });

  it('scales Retry-After down as the cooldown burns', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    time.advance(4000); // 6s left
    const rejected = (await rejectionOf(
      breakerCall(breaker, () => 'ok')
    )) as HttpError;
    (rejected.headers?.['retry-after'] ?? '').should.equal('6');
  });

  it('admits probes after the cooldown and caps them at probeConcurrency', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    canPass(breaker).should.be.false;
    time.advance(5000);
    // Lazy transition: the first canPass after the cooldown moves to half-open.
    canPass(breaker).should.be.true;
    circuitStatus(breaker).phase.should.equal('half-open');
    circuitStatus(breaker).probesInFlight.should.equal(1);
    // Default concurrency 1: the outstanding probe owns the only slot.
    canPass(breaker).should.be.false;
    const rejected = (await rejectionOf(
      breakerCall(breaker, () => 'ok')
    )) as HttpError;
    // A slot rejection, not a cooldown: Retry-After floors at 1s.
    (rejected.headers?.['retry-after'] ?? '').should.equal('1');
  });

  it('supports concurrent probes when probeConcurrency is raised', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      probeConcurrency: 2,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    time.advance(5000);
    canPass(breaker).should.be.true;
    canPass(breaker).should.be.true;
    canPass(breaker).should.be.false;
    recordSuccess(breaker); // releases one slot
    canPass(breaker).should.be.true;
  });

  it('a probe failure re-trips open and restarts the cooldown', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    time.advance(5000);
    const firstProbe = (await rejectionOf(breakerCall(breaker, boom))) as Error;
    firstProbe.message.should.equal('upstream dead'); // underlying error passes through
    circuitStatus(breaker).phase.should.equal('open');
    // The cooldown restarted at the re-trip: past the OLD opening, not the new one.
    time.advance(4999);
    canPass(breaker).should.be.false;
    time.advance(1);
    canPass(breaker).should.be.true;
    circuitStatus(breaker).phase.should.equal('half-open');
  });

  it('closes after successesNeeded consecutive probe successes, window fresh', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      windowMs: 10_000,
      cooldownMs: 5000,
      successesNeeded: 2,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    recordFailure(breaker, deadError()); // trips
    time.advance(5000);
    (await breakerCall(breaker, () => 'ok')).should.equal('ok');
    circuitStatus(breaker).phase.should.equal('half-open');
    circuitStatus(breaker).successes.should.equal(1);
    await breakerCall(breaker, () => 'ok');
    circuitStatus(breaker).phase.should.equal('closed');
    // The closed era starts with a clean window: one failure is not two.
    recordFailure(breaker, deadError());
    circuitStatus(breaker).phase.should.equal('closed');
    recordFailure(breaker, deadError());
    circuitStatus(breaker).phase.should.equal('open');
  });

  it('successes in closed never erase failures — only the window slides them out', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      windowMs: 10_000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    recordSuccess(breaker);
    recordFailure(breaker, deadError()); // two live failures despite the success
    circuitStatus(breaker).phase.should.equal('open');
  });
});

describe('circuitBreaker errorFilter', function () {
  it('skipClientErrors: 4xx answers do not accrue, 5xx and raw throws do', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      windowMs: 10_000,
      errorFilter: skipClientErrors,
      now: time.now,
    });
    recordFailure(breaker, httpError(404, 'Not Found')).should.be.false;
    recordFailure(breaker, httpError(429, 'Too Many Requests')).should.be.false;
    circuitStatus(breaker).phase.should.equal('closed');
    recordFailure(breaker, httpError(502, 'Bad Gateway')).should.be.true;
    recordFailure(breaker, deadError()).should.be.true;
    circuitStatus(breaker).phase.should.equal('open');
  });

  it('a filtered error in half-open releases its slot without tripping', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      errorFilter: skipClientErrors,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    time.advance(5000);
    circuitStatus(breaker).phase.should.equal('half-open'); // lazy, no slot taken
    // The probe "fails" with a client error: slot released, breaker stays half-open.
    const passthrough = (await rejectionOf(
      breakerCall(breaker, () => {
        throw httpError(404, 'Not Found');
      })
    )) as HttpError;
    passthrough.status.should.equal(404);
    circuitStatus(breaker).phase.should.equal('half-open');
    circuitStatus(breaker).probesInFlight.should.equal(0);
    // But it earned nothing: successesNeeded successes are still required.
    circuitStatus(breaker).successes.should.equal(0);
  });

  it('breakerCall records through the filter and never translates the underlying error', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      errorFilter: skipClientErrors,
      now: time.now,
    });
    const err = (await rejectionOf(
      breakerCall(breaker, () => {
        throw httpError(504, 'Gateway Timeout');
      })
    )) as HttpError;
    err.status.should.equal(504);
    circuitStatus(breaker).phase.should.equal('open');
  });
});

describe('circuitBreaker faces', function () {
  it('canPass + record* is the no-throw face: a fallback instead of a 503', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    let fallback = false;
    if (!canPass(breaker)) {
      fallback = true; // the caller answers, no error boundary involved
    }
    fallback.should.be.true;
  });

  it('circuitStatus reports the lazy phase and freezes the snapshot', function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      now: time.now,
    });
    recordFailure(breaker, deadError());
    const open = circuitStatus(breaker);
    open.phase.should.equal('open');
    open.retryAtMs.should.equal(5000);
    time.advance(5000);
    circuitStatus(breaker).phase.should.equal('half-open'); // lazy, via status
    Object.isFrozen(open).should.be.true;
  });

  it('rejects non-positive options at creation', function () {
    (() => createCircuitBreaker({ failureThreshold: 0 })).should.throw(
      /must be positive/
    );
    (() => createCircuitBreaker({ windowMs: -1 })).should.throw(
      /must be positive/
    );
    (() => createCircuitBreaker({ cooldownMs: 0 })).should.throw(
      /must be positive/
    );
    (() => createCircuitBreaker({ successesNeeded: 0 })).should.throw(
      /must be positive/
    );
    (() => createCircuitBreaker({ probeConcurrency: -2 })).should.throw(
      /must be positive/
    );
  });

  it('answers 503 through the app error boundary once tripped', async function () {
    const time = clock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 8000,
      now: time.now,
    });
    const app = createApp();
    get(app, '/upstream', () => breakerCall(breaker, boom));
    (await handle(app, new Request('http://localhost/upstream'))).status.should.equal(500);
    const rejected = await handle(app, new Request('http://localhost/upstream'));
    rejected.status.should.equal(503);
    (await rejected.json()).should.deep.equal({ error: 'Service Unavailable' });
    (rejected.headers.get('retry-after') ?? '').should.equal('8');
  });
});
