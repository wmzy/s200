import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { accepts, parseRanges } from '../src/accepts';

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

  it('skips empty segments in the header list', async () => {
    const picked = await pick(
      'text/html, , application/json;q=0.5',
      ['application/json', 'text/html'],
      'type'
    );
    picked!.should.equal('text/html');
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

  it('parseRanges captures each entry\'s params for param-carrying consumers', () => {
    parseRanges(
      'application/vnd.api+json; q=0.9; version="2.0"; Charset=utf-8, text/html'
    ).should.deep.equal([
      {
        value: 'application/vnd.api+json',
        q: 0.9,
        // q never lands in params; keys fold to lowercase, quoted values
        // unquote, later occurrences of a name win.
        params: new Map([
          ['version', '2.0'],
          ['charset', 'utf-8'],
        ]),
      },
      { value: 'text/html', q: 1, params: new Map() },
    ]);
  });

  it('parseRanges unfolds quoted params with the shared escape semantics', () => {
    // Escaped newline unfolds to a bare LF and an escaped quote to `"`
    // (the escape character is always consumed); an escaped backslash
    // unfolds to a single `\`; bare and empty-quoted tokens pass through.
    // (A trailing LONE backslash cannot ride a terminated value — it
    // would eat the closing quote and run the value on — so that unfold
    // is pinned by multipart's boundary tests instead.)
    const [range] = parseRanges(
      'text/html; nl="a\\\nb"; esc="say \\"hi\\""; end="x\\\\"; tok=plain; empty=""'
    );
    range!.params.get('nl')!.should.equal('a\nb');
    range!.params.get('esc')!.should.equal('say "hi"');
    range!.params.get('end')!.should.equal('x\\');
    range!.params.get('tok')!.should.equal('plain');
    range!.params.get('empty')!.should.equal('');
  });

  it('parseRanges keeps a quoted parameter value containing a semicolon intact', () => {
    // A `;` inside quotes is data, not a separator — the parameter split
    // is quote-aware (raw-headers' shared grammar), so `version="1.0;ext=a"`
    // arrives as ONE parameter and unfolds whole; the q after it still
    // parses. The naive `split(';')` used to shred this into
    // version="1.0 / ext=a" garbage.
    const [range] = parseRanges(
      'application/vnd.api+json; version="1.0;ext=a"; q=0.8, text/html'
    );
    range!.value.should.equal('application/vnd.api+json');
    range!.q.should.equal(0.8);
    range!.params.size.should.equal(1);
    range!.params.get('version')!.should.equal('1.0;ext=a');
  });
});
