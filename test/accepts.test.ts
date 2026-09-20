import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { accepts } from '../src/accepts';

/** Captures what a handler picked from the request's Accept headers. */
async function pick(header: string, provided: string[], which: 'type' | 'encoding' | 'language'): Promise<string | undefined> {
  let picked: string | undefined;
  const app = createApp();
  use(app, async (ctx, next) => {
    picked = accepts(ctx)[which](provided);
    return next();
  });
  get(app, '/', () => new Response('ok'));
  const init: RequestInit = {};
  if (header !== '') {
    init.headers =
      which === 'encoding'
        ? { 'accept-encoding': header }
        : which === 'language'
          ? { 'accept-language': header }
          : { accept: header };
  }
  await handle(app, new Request('http://localhost/', init));
  return picked;
}

describe('accepts', () => {
  it('picks the client-preferred type by q-value', async () => {
    const picked = await pick(
      'text/html, application/json;q=0.9',
      ['application/json', 'text/html'],
      'type'
    );
    picked!.should.equal('text/html');
  });

  it('falls to the higher-q type when the favorite is downgraded', async () => {
    const picked = await pick(
      'text/html;q=0.5, application/json',
      ['application/json', 'text/html'],
      'type'
    );
    picked!.should.equal('application/json');
  });

  it('matches wildcards and type/* ranges', async () => {
    (await pick('*/*', ['application/json'], 'type'))!.should.equal('application/json');
    (await pick('text/*', ['application/json', 'text/html'], 'type'))!.should.equal('text/html');
  });

  it('a specific q=0 ban beats a permissive wildcard (RFC 9110 §12.4.2)', async () => {
    const picked = await pick(
      'text/html;q=0, */*;q=0.5',
      ['text/html', 'application/json'],
      'type'
    );
    picked!.should.equal('application/json');
  });

  it('returns undefined when nothing matches or is acceptable', async () => {
    (await pick('image/png', ['application/json'], 'type') === undefined).should.be.true;
    (await pick('text/html;q=0', ['text/html'], 'type') === undefined).should.be.true;
    (await pick('', ['application/json'], 'type') === undefined).should.be.true;
  });

  it('keeps server preference order on q ties', async () => {
    const picked = await pick(
      'application/json, text/html',
      ['text/html', 'application/json'],
      'type'
    );
    picked!.should.equal('text/html');
  });

  it('negotiates encodings with q-values and wildcards', async () => {
    (await pick('gzip, deflate;q=0.5, br;q=0', ['br', 'deflate', 'gzip'], 'encoding'))!.should.equal('gzip');
    (await pick('*', ['br'], 'encoding'))!.should.equal('br');
  });

  it('negotiates languages with subtag prefix matching', async () => {
    (await pick('zh-CN, zh;q=0.9, en;q=0.8', ['en', 'zh-CN'], 'language'))!.should.equal('zh-CN');
    (await pick('en-US', ['en'], 'language') === undefined).should.be.true;
    (await pick('en', ['en-US', 'en-GB'], 'language'))!.should.equal('en-US');
  });

  it('handles a q=0 ban for languages too', async () => {
    const picked = await pick('fr;q=0, *;q=0.9', ['fr', 'de'], 'language');
    picked!.should.equal('de');
  });
});
