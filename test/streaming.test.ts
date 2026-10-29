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

  it('keeps custom headers supplied as a Headers instance', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(
        ctx,
        async (writer) => {
          await writer.write('a');
        },
        {
          status: 201,
          headers: new Headers({
            'content-type': 'application/custom',
            'x-stream': 'yes',
          }),
        },
      ),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(201);
    res.headers.get('content-type')!.should.equal('application/custom');
    res.headers.get('x-stream')!.should.equal('yes');
  });

  it('keeps custom headers supplied as a [name, value] pair list', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(
        ctx,
        async (writer) => {
          await writer.write('a');
        },
        { headers: [['content-type', 'application/pairs'], ['x-stream', 'yes']] },
      ),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-type')!.should.equal('application/pairs');
    res.headers.get('x-stream')!.should.equal('yes');
  });

  it('keeps plain-record headers and fills the default content-type only when absent', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      stream(
        ctx,
        async (writer) => {
          await writer.write('a');
        },
        { headers: { 'x-stream': 'yes' } },
      ),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-type')!.should.equal('application/octet-stream');
    res.headers.get('x-stream')!.should.equal('yes');
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

  it('accepts a Headers instance: explicit headers win, absent defaults fill', async function () {
    const app = createApp();
    get(app, '/', (ctx) =>
      streamSSE(
        ctx,
        async (writer) => {
          await writer.writeSSE({ data: 'hello' });
        },
        {
          headers: new Headers({
            'content-type': 'text/custom-stream',
            'x-sse': 'yes',
          }),
        },
      ),
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-type')!.should.equal('text/custom-stream');
    res.headers.get('cache-control')!.should.equal('no-cache');
    res.headers.get('x-sse')!.should.equal('yes');
  });
});
