import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { text } from '../src/respond';
import { startTiming, timing } from '../src/timing';

/** The exact header shape `timing()` emits: `name;dur=N.N` entries joined
 * by `", "`, where N.N is milliseconds with one fractional digit. */
const FORMAT = /^[!#$%&'*+\-.^_`|~\w]+;dur=\d+\.\d+(?:, [!#$%&'*+\-.^_`|~\w]+;dur=\d+\.\d+)*$/;

describe('timing', function () {
  it('stamps the total on a plain 200 — no spans registered', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    const header = res.headers.get('server-timing');
    header?.should.be.a('string');
    header?.should.match(/^total;dur=\d+\.\d$/);
    Number(header?.slice('total;dur='.length)).should.be.at.least(0);
  });

  it('lists named spans in registration order, then the total, with numeric durations', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', async (ctx) => {
      const stopDb = startTiming(ctx, 'db');
      const stopRender = startTiming(ctx, 'render');
      stopDb();
      stopRender();
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    const header = res.headers.get('server-timing') ?? '';
    header.should.match(/^db;dur=\d+\.\d, render;dur=\d+\.\d, total;dur=\d+\.\d$/);
    for (const entry of header.split(', ')) {
      Number(entry.split(';dur=')[1]).should.be.at.least(0);
    }
  });

  it('regex-verifies the exact header format on a multi-span response', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', async (ctx) => {
      const stop = startTiming(ctx, 'cache');
      stop();
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('server-timing') ?? '').should.match(FORMAT);
  });

  it('stamps the header on the 404 fallback', async function () {
    const app = createApp();
    use(app, timing());
    const res = await handle(app, new Request('http://localhost/nope'));
    res.status.should.equal(404);
    (res.headers.get('server-timing') ?? '').should.match(/^total;dur=\d+\.\d$/);
  });

  it('stamps the header on the 500 error response of a throwing handler', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);
    (res.headers.get('server-timing') ?? '').should.match(FORMAT);
  });

  it('closes an unstopped span at stamp time', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', async (ctx) => {
      startTiming(ctx, 'db'); // stop function dropped on purpose
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('server-timing') ?? '').should.match(
      /^db;dur=\d+\.\d, total;dur=\d+\.\d$/
    );
  });

  it('records the first duration only when stop runs twice', async function () {
    const app = createApp();
    use(app, timing());
    get(app, '/x', async (ctx) => {
      const stop = startTiming(ctx, 'db');
      stop();
      stop();
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('server-timing') ?? '').should.match(
      /^db;dur=\d+\.\d, total;dur=\d+\.\d$/
    );
  });

  it('honors the total-name option', async function () {
    const app = createApp();
    use(app, timing({ total: 'app' }));
    get(app, '/x', async (ctx) => {
      const stop = startTiming(ctx, 'db');
      stop();
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('server-timing') ?? '').should.match(
      /^db;dur=\d+\.\d, app;dur=\d+\.\d$/
    );
  });

  it('never crashes without the middleware — spans are simply never stamped', async function () {
    const app = createApp();
    get(app, '/x', async (ctx) => {
      const stop = startTiming(ctx, 'db');
      stop();
      return text(ctx, 'ok');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    res.headers.has('server-timing').should.equal(false);
  });
});
