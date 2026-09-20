import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { logger } from '../src/logger';
import { text } from '../src/respond';

describe('logger', function () {
  it('emits one line per request with the response status', async function () {
    const lines: string[] = [];
    const app = createApp();
    use(app, logger({ sink: (line) => lines.push(line) }));
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    lines.should.have.length(1);
    lines[0]?.should.match(/ GET \/x 200 /);
  });

  it('reports the real status of materialized fallbacks', async function () {
    const lines: string[] = [];
    const app = createApp();
    use(app, logger({ sink: (line) => lines.push(line) }));
    const res = await handle(app, new Request('http://localhost/nope'));
    res.status.should.equal(404);
    lines.should.have.length(1);
    lines[0]?.should.match(/ GET \/nope 404 /);
  });

  it('passes the measured duration to a custom format function', async function () {
    const seen: number[] = [];
    const app = createApp();
    use(
      app,
      logger({
        format: (_ctx, ms) => {
          seen.push(ms);
          return 'line';
        },
        sink: () => undefined,
      })
    );
    get(app, '/x', () => new Response('ok'));
    await handle(app, new Request('http://localhost/x'));
    seen.should.have.length(1);
    seen[0]?.should.be.at.least(0);
  });

  it('does not log when the chain rejects', async function () {
    const lines: string[] = [];
    const app = createApp();
    use(app, logger({ sink: (line) => lines.push(line) }));
    get(app, '/x', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);
    lines.should.have.length(0);
  });
});
