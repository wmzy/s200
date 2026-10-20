import { describe, it } from 'vitest';

import { createApp, use } from '../src/app';
import { httpError } from '../src/errors';
import { setHeader } from '../src/respond';
import {
  matchWebSocket,
  resolveUpgrade,
  upgradeWebSocket,
} from '../src/websocket';

describe('websocket registry', () => {
  it('matches patterns with params and wildcards, percent-decoded', () => {
    const app = createApp();
    upgradeWebSocket(app, '/chat/:room', () => undefined);
    upgradeWebSocket(app, '/files/*rest', () => undefined);
    matchWebSocket(app, '/chat/general')!.params.should.deep.equal({ room: 'general' });
    matchWebSocket(app, '/chat/a%20b')!.params.should.deep.equal({ room: 'a b' });
    matchWebSocket(app, '/files/a/b/c')!.params.should.deep.equal({ rest: 'a/b/c' });
  });

  it('first registration wins, exactly like HTTP routes', () => {
    const app = createApp();
    const first = (): undefined => undefined;
    const second = (): undefined => undefined;
    upgradeWebSocket(app, '/same', first);
    upgradeWebSocket(app, '/same', second);
    const matched = matchWebSocket(app, '/same')!;
    matched.route.handler.should.equal(first);
    matched.route.pattern.should.equal('/same');
  });

  it('returns undefined for non-matching paths', () => {
    const app = createApp();
    upgradeWebSocket(app, '/chat/:room', () => undefined);
    (matchWebSocket(app, '/nope') === undefined).should.be.true;
    (matchWebSocket(app, '/chat') === undefined).should.be.true;
    (matchWebSocket(app, '/chat/') === undefined).should.be.true; // strict
  });

  it('registries are per-app — no cross-app leakage', () => {
    const a = createApp();
    const b = createApp();
    upgradeWebSocket(a, '/ws', () => undefined);
    (matchWebSocket(b, '/ws') === undefined).should.be.true;
  });

  it('rejects malformed patterns at registration', () => {
    const app = createApp();
    (() => upgradeWebSocket(app, '/x/:', () => undefined)).should.throw();
    (() => upgradeWebSocket(app, '/x/:a/:a', () => undefined)).should.throw();
  });

  it('returns the app from upgradeWebSocket for chaining', () => {
    const app = createApp();
    upgradeWebSocket(app, '/ws', () => undefined).should.equal(app);
  });

  it('records route-scoped middlewares ahead of the handler', () => {
    const app = createApp();
    const gate = async (_ctx: unknown, next: () => Promise<void>) => next();
    const handler = (): undefined => undefined;
    upgradeWebSocket(app, '/ws', gate, gate, handler);
    const matched = matchWebSocket(app, '/ws')!;
    matched.route.middlewares.length.should.equal(2);
    matched.route.middlewares[0]!.should.equal(gate);
    matched.route.handler.should.equal(handler);
  });

  it('keeps the old four-argument shape working (no middlewares)', () => {
    const app = createApp();
    const handler = (): undefined => undefined;
    upgradeWebSocket(app, '/ws', handler, { protocols: ['chat'] });
    const matched = matchWebSocket(app, '/ws')!;
    matched.route.middlewares.should.deep.equal([]);
    matched.route.handler.should.equal(handler);
    (matched.route.protocols ?? []).should.deep.equal(['chat']);
  });

  it('treats a trailing undefined options as the old default', () => {
    const app = createApp();
    const handler = (): undefined => undefined;
    upgradeWebSocket(app, '/ws', handler, undefined);
    const matched = matchWebSocket(app, '/ws')!;
    matched.route.handler.should.equal(handler);
    (matched.route.protocols === undefined).should.be.true;
  });

  it('throws when no terminal handler is given', () => {
    const app = createApp();
    const noArgs = [] as unknown as [() => undefined];
    (() => upgradeWebSocket(app, '/ws', ...noArgs)).should.throw(/terminal handler/);
  });
});

describe('websocket upgrade decision (middleware chain)', () => {
  const decide = async (
    app: ReturnType<typeof createApp>,
    path = '/ws'
  ): Promise<ReturnType<typeof resolveUpgrade>> => {
    const matched = matchWebSocket(app, path)!;
    const url = new URL(`http://localhost${path}`);
    return resolveUpgrade(
      app,
      matched.route,
      new Request(url),
      url,
      matched.params
    );
  };

  it('approves when the chain settles without a response, carrying state', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      ctx.state.user = 'alice';
      await next();
    });
    upgradeWebSocket(
      app,
      '/ws',
      async (ctx, next) => {
        ctx.state.sawRoute = ctx.state.user;
        await next();
      },
      () => undefined
    );
    const decision = await decide(app);
    decision.ok.should.be.true;
    if (decision.ok) {
      (decision.ctx.state.user as string).should.equal('alice');
      (decision.ctx.state.sawRoute as string).should.equal('alice');
      (decision.ctx.res === undefined).should.be.true;
    }
  });

  it('runs route middlewares after the app chain', async () => {
    const app = createApp();
    const order: string[] = [];
    use(app, async (_ctx, next) => {
      order.push('app');
      await next();
    });
    upgradeWebSocket(
      app,
      '/ws',
      async (_ctx, next) => {
        order.push('route');
        await next();
      },
      () => undefined
    );
    await decide(app);
    order.should.deep.equal(['app', 'route']);
  });

  it('rejects when an app-level middleware answers', async () => {
    const app = createApp();
    use(app, (ctx) => {
      ctx.res = new Response('no token', { status: 401 });
    });
    upgradeWebSocket(app, '/ws', () => undefined);
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      decision.response.status.should.equal(401);
      (await decision.response.text()).should.equal('no token');
    }
  });

  it('rejects when a route-level middleware answers', async () => {
    const app = createApp();
    upgradeWebSocket(
      app,
      '/ws',
      (ctx) => {
        ctx.res = new Response('forbidden', { status: 403 });
      },
      () => undefined
    );
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      decision.response.status.should.equal(403);
      (await decision.response.text()).should.equal('forbidden');
    }
  });

  it('rejects when a middleware RETURNS a response', async () => {
    const app = createApp();
    // Off-contract for HTTP middlewares, honored on upgrades: a returned
    // Response answers the handshake request.
    const answers = async (): Promise<void> =>
      new Response('returned', { status: 418 }) as unknown as void;
    upgradeWebSocket(app, '/ws', answers, () => undefined);
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      decision.response.status.should.equal(418);
      (await decision.response.text()).should.equal('returned');
    }
  });

  it('maps a thrown HttpError to its status and envelope', async () => {
    const app = createApp();
    upgradeWebSocket(
      app,
      '/ws',
      () => {
        throw httpError(401, 'missing token');
      },
      () => undefined
    );
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      decision.response.status.should.equal(401);
      (await decision.response.json()).should.deep.equal({ error: 'missing token' });
    }
  });

  it('maps unexpected errors to an anonymous 500 through logError', async () => {
    const app = createApp({ logError: () => undefined });
    upgradeWebSocket(
      app,
      '/ws',
      () => {
        throw new Error('boom');
      },
      () => undefined
    );
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      decision.response.status.should.equal(500);
      (await decision.response.json()).should.deep.equal({ error: 'Internal Server Error' });
    }
  });

  it('routes errors through a custom onError, falling back when it stays silent', async () => {
    const answered = createApp({
      onError: (ctx) => {
        ctx.res = new Response('maintenance', { status: 503 });
      },
    });
    upgradeWebSocket(answered, '/ws', () => {
      throw new Error('boom');
    }, () => undefined);
    const answeredDecision = await decide(answered);
    answeredDecision.ok.should.be.false;
    if (!answeredDecision.ok) {
      answeredDecision.response.status.should.equal(503);
    }

    const silent = createApp({ onError: () => undefined, logError: () => undefined });
    upgradeWebSocket(silent, '/ws', () => {
      throw httpError(429, 'slow down');
    }, () => undefined);
    const silentDecision = await decide(silent);
    silentDecision.ok.should.be.false;
    if (!silentDecision.ok) {
      // A silent onError falls back to the default mapping — an upgrade
      // has no fallback body to answer with.
      silentDecision.response.status.should.equal(429);
      (await silentDecision.response.json()).should.deep.equal({ error: 'slow down' });
    }
  });

  it('applies prefix-scoped app middleware groups to upgrades', async () => {
    const app = createApp();
    use(app, '/admin', (ctx) => {
      ctx.res = new Response('admins only', { status: 403 });
    });
    upgradeWebSocket(app, '/admin/ws', () => undefined);
    upgradeWebSocket(app, '/open/ws', () => undefined);
    const denied = await decide(app, '/admin/ws');
    denied.ok.should.be.false;
    if (!denied.ok) {
      denied.response.status.should.equal(403);
    }
    const allowed = await decide(app, '/open/ws');
    allowed.ok.should.be.true;
  });

  it('rides pending setHeader entries onto the rejection response', async () => {
    const app = createApp();
    use(app, (ctx) => {
      setHeader(ctx, 'x-ws-verdict', 'denied');
      ctx.res = new Response('no', { status: 401 });
    });
    upgradeWebSocket(app, '/ws', () => undefined);
    const decision = await decide(app);
    decision.ok.should.be.false;
    if (!decision.ok) {
      (decision.response.headers.get('x-ws-verdict') ?? '').should.equal('denied');
    }
  });
});
