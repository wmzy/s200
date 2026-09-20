import { describe, it } from 'vitest';

import { createApp, get, handle } from '../src/app';
import { stream, streamSSE } from '../src/streaming';

describe('stream', function () {
  it('serves pushed chunks and closes when the pump finishes', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(ctx, async (writer) => {
        await writer.write('a');
        await writer.write('b');
      }),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    (await res.text()).should.equal('ab');
  });

  it('accepts Uint8Array chunks and honors a custom content-type', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(
        ctx,
        async (writer) => {
          await writer.write(new TextEncoder().encode('raw'));
        },
        { headers: { 'content-type': 'application/custom' } },
      ),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-type')!.should.equal('application/custom');
    (await res.text()).should.equal('raw');
  });

  it('surfaces pump failures through the response stream', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(ctx, async (writer) => {
        await writer.write('partial');
        writer.abort(new Error('source died'));
      }),
    );
    const res = await handle(app, new Request('http://localhost/'));
    await res.text().then(
      () => {
        throw new Error('expected the body to reject');
      },
      (error: Error) => {
        error.should.be.an('error');
      },
    );
  });
});

describe('streamSSE', function () {
  it('frames events and heartbeat comments per the event-stream format', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      streamSSE(ctx, async (writer) => {
        await writer.writeSSE({ data: 'hello' });
        await writer.heartbeat();
        await writer.writeSSE({ id: '1', event: 'update', data: { n: 1 }, retry: 5000 });
      }),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-type')!.should.equal('text/event-stream');
    res.headers.get('cache-control')!.should.equal('no-cache');
    (await res.text()).should.equal(
      'data: hello\n\n' +
        ': heartbeat\n\n' +
        'id: 1\nevent: update\ndata: {"n":1}\nretry: 5000\n\n',
    );
  });

  it('splits multiline data into repeated data: fields', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      streamSSE(ctx, async (writer) => {
        await writer.writeSSE({ data: 'line1\nline2' });
      }),
    );
    const res = await handle(app, new Request('http://localhost/'));
    (await res.text()).should.equal('data: line1\ndata: line2\n\n');
  });
});
