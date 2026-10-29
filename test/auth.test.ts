import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { basicAuth, bearerAuth, extractBearer } from '../src/auth';
import { isHttpError } from '../src/errors';
import { json } from '../src/respond';

/** UTF-8-aware basic credential encoding (what browsers send). */
function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

describe('basicAuth', () => {
  it('lets verified credentials through to the handler', async () => {
    const app = createApp();
    use(
      app,
      basicAuth((username, password) => username === 'admin' && password === 'hunter2')
    );
    get(app, '/', () => new Response('hi'));
    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { authorization: basic('admin', 'hunter2') },
      })
    );
    res.status.should.equal(200);
  });

  it('supports async verifiers', async () => {
    const app = createApp();
    use(app, basicAuth(async () => true));
    get(app, '/', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { authorization: basic('u', 'p') },
      })
    );
    res.status.should.equal(200);
  });

  it('answers 401 with a Basic challenge on bad credentials, chain never runs', async () => {
    const app = createApp();
    let ran = false;
    use(
      app,
      basicAuth((username, password) => username === 'admin' && password === 'right')
    );
    get(app, '/', () => {
      ran = true;
      return new Response('ok');
    });
    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { authorization: basic('admin', 'wrong') },
      })
    );
    res.status.should.equal(401);
    res.headers.get('www-authenticate')!.should.equal('Basic realm="s200"');
    (await res.json()).should.deep.equal({ error: 'Unauthorized' });
    ran.should.be.false;
  });

  it('answers 401 for missing or malformed headers without throwing', async () => {
    const app = createApp();
    use(app, basicAuth(() => true));
    get(app, '/', () => new Response('ok'));
    for (const header of [undefined, 'Basic !!!not-base64!!!', 'Bearer xyz', 'Basic aGVsbG8=' /* no colon */]) {
      const init: RequestInit = {};
      if (header !== undefined) init.headers = { authorization: header };
      const res = await handle(app, new Request('http://localhost/', init));
      res.status.should.equal(401);
    }
  });

  it('round-trips non-ASCII credentials through the UTF-8 decode', async () => {
    const app = createApp();
    use(app, basicAuth((username, password) => username === 'üser' && password === 'päss'));
    get(app, '/', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { authorization: basic('üser', 'päss') },
      })
    );
    res.status.should.equal(200);
  });

  it('advertises a custom realm', async () => {
    const app = createApp();
    use(app, basicAuth(() => false, { realm: 'api' }));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('www-authenticate')!.should.equal('Basic realm="api"');
  });

  it('hands the 401 rejection to a configured onError, challenge on the error', async () => {
    const seen: unknown[] = [];
    const app = createApp({
      onError: (ctx, error) => {
        seen.push(error);
        json(ctx, { reason: 'denied by policy' }, { status: 403 });
      },
    });
    use(app, basicAuth(() => false));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    // The policy owns the wire answer.
    res.status.should.equal(403);
    (await res.json()).should.deep.equal({ reason: 'denied by policy' });
    // What it saw was the gate's 401 with the challenge tagged onto it.
    const err = seen[0];
    isHttpError(err).should.be.true;
    if (isHttpError(err)) {
      err.status.should.equal(401);
      (err.headers?.['www-authenticate'] ?? '').should.equal('Basic realm="s200"');
    }
  });
});

describe('extractBearer', () => {
  it('extracts the token for any scheme casing and separator width', () => {
    extractBearer('Bearer abc')!.should.equal('abc');
    extractBearer('bearer abc')!.should.equal('abc');
    extractBearer('BEARER abc')!.should.equal('abc');
    extractBearer('Bearer\tabc')!.should.equal('abc');
    extractBearer('Bearer   abc')!.should.equal('abc');
    // Only the first separator run splits — the token itself keeps its
    // internal whitespace.
    extractBearer('Bearer a b')!.should.equal('a b');
  });

  it('returns undefined for absent or non-matching values', () => {
    (extractBearer(null) === undefined).should.be.true;
    (extractBearer('') === undefined).should.be.true;
    (extractBearer('Basic dXNlcjpwYXNz') === undefined).should.be.true;
    (extractBearer('Bearerabc') === undefined).should.be.true; // no separator
    (extractBearer('Bearer ') === undefined).should.be.true; // empty token
  });

  it('honors a custom scheme, still case-insensitive and escaped', () => {
    extractBearer('Token xyz', 'Token')!.should.equal('xyz');
    extractBearer('token\txyz', 'Token')!.should.equal('xyz');
    (extractBearer('Bearer xyz', 'Token') === undefined).should.be.true;
    // Regex metacharacters in a custom scheme are matched literally.
    extractBearer('Te.xen 1', 'Te.xen')!.should.equal('1');
    (extractBearer('TeXen 1', 'Te.xen') === undefined).should.be.true;
  });
});

describe('bearerAuth', () => {
  it('lets verified tokens through and answers 401 otherwise', async () => {
    const app = createApp();
    use(app, bearerAuth((token) => token === 'secret'));
    get(app, '/', () => new Response('ok'));
    const ok = await handle(
      app,
      new Request('http://localhost/', { headers: { authorization: 'Bearer secret' } })
    );
    ok.status.should.equal(200);

    const bad = await handle(
      app,
      new Request('http://localhost/', { headers: { authorization: 'Bearer nope' } })
    );
    bad.status.should.equal(401);
    bad.headers.get('www-authenticate')!.should.equal('Bearer realm="s200"');

    const missing = await handle(app, new Request('http://localhost/'));
    missing.status.should.equal(401);
  });

  it('is case-insensitive on the scheme like HTTP auth requires', async () => {
    const app = createApp();
    use(app, bearerAuth((token) => token === 't'));
    get(app, '/', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: { authorization: 'bearer t' } })
    );
    res.status.should.equal(200);
  });

  it('hands the 401 rejection to a configured onError, challenge on the error', async () => {
    const seen: unknown[] = [];
    const app = createApp({
      onError: (ctx, error) => {
        seen.push(error);
        json(ctx, { reason: 'denied by policy' }, { status: 403 });
      },
    });
    use(app, bearerAuth(() => false));
    get(app, '/', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: { authorization: 'Bearer nope' } })
    );
    res.status.should.equal(403);
    (await res.json()).should.deep.equal({ reason: 'denied by policy' });
    const err = seen[0];
    isHttpError(err).should.be.true;
    if (isHttpError(err)) {
      err.status.should.equal(401);
      (err.headers?.['www-authenticate'] ?? '').should.equal('Bearer realm="s200"');
    }
  });
});
