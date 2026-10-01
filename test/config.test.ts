import type { StandardIssue, StandardSchema, StandardSchemaV1 } from '../src/validate';

import { describe, expectTypeOf, it } from 'vitest';

import { createConfig, parseEnv, type Config } from '../src/config';

/** Runs parseEnv, returning the thrown Error — fails the test when
 * nothing is thrown, so the assertions below stay honest. */
function envError(text: string): Error {
  try {
    parseEnv(text);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error(`parseEnv(${JSON.stringify(text)}) did not throw`);
}

// ---- Standard Schema fakes (the `~standard` vendor shape) ----

/** The typed product of envSchema: env strings in, coerced primitives out. */
type EnvOut = { readonly PORT: number; readonly VERBOSE: boolean };

/** Hand-rolled standard schema mimicking the env-string reality: its
 * input is strings (what parseEnv yields), its output the coerced values
 * — input and output differ on purpose, which is the whole point of
 * pairing createConfig with an env schema. */
const envSchema: StandardSchemaV1 & {
  readonly types?: {
    readonly input: { readonly PORT: string; readonly VERBOSE: string };
    readonly output: EnvOut;
  };
} = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: (value) => {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
        string,
        unknown
      >;
      const port = record['PORT'];
      const verbose = record['VERBOSE'];
      const issues: StandardIssue[] = [];
      if (port !== undefined && (typeof port !== 'string' || !/^\d+$/.test(port))) {
        issues.push({
          message: `expected number, got ${typeof port === 'string' ? JSON.stringify(port) : String(port)}`,
          path: ['PORT'],
        });
      }
      if (verbose !== undefined && typeof verbose !== 'string') {
        issues.push({ message: 'expected string', path: ['VERBOSE'] });
      }
      if (issues.length > 0) {
        return { issues };
      }
      return {
        value: { PORT: port === undefined ? 3000 : Number(port), VERBOSE: verbose === 'true' },
      };
    },
  },
};

/** Issues-only schema: three failures with mixed path shapes. */
const brokenSchema: StandardSchema = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: () => ({
      issues: [
        { message: 'expected number, got "abc"', path: ['PORT'] },
        { message: 'required', path: ['db', 'url'] },
        { message: 'boom' },
      ],
    }),
  },
};

/** Empty-issues schema: `{ issues: [] }` is a success, not a failure. */
const lenientSchema: StandardSchema<string> = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: () => ({ issues: [], value: 'ok' }),
  },
};

// ---- parseEnv ----

describe('parseEnv', function () {
  it('parses bare pairs and skips blanks and comment lines', function () {
    parseEnv('# header\n\n  HOST = localhost  \n\t# indented\n').should.deep.equal({
      HOST: 'localhost',
    });
  });

  it('strips an export prefix but keeps export-shaped keys intact', function () {
    parseEnv('export A=1\nexportB=2\nexport=3').should.deep.equal({
      A: '1',
      exportB: '2',
      export: '3',
    });
  });

  it('treats # inside quotes as data and trailing # as a comment', function () {
    parseEnv('A="a # b"\nB=\'x # y\'\nC=val # note\nD=abc#def\nE=# whole value').should.deep.equal(
      { A: 'a # b', B: 'x # y', C: 'val', D: 'abc#def', E: '' }
    );
  });

  it('unescapes double-quoted values but keeps single quotes literal', function () {
    parseEnv('A="l1\\nl2"\nB="t\\tb"\nC="C:\\\\Users"\nD="q\\"q"\nE="keep\\q"').should.deep.equal(
      { A: 'l1\nl2', B: 't\tb', C: 'C:\\Users', D: 'q"q', E: 'keep\\q' }
    );
    parseEnv("S='a\\nb'").should.deep.equal({ S: 'a\\nb' });
  });

  it('trims bare values and keeps embedded equals signs', function () {
    parseEnv('A=  padded  \nURL=http://x/?a=1').should.deep.equal({
      A: 'padded',
      URL: 'http://x/?a=1',
    });
  });

  it('reads empty values and lets the last duplicate win', function () {
    parseEnv('A=\nB=\t\nD=1\nD=2').should.deep.equal({ A: '', B: '', D: '2' });
  });

  it('splits CRLF and LF lines alike', function () {
    parseEnv('A=1\r\nB=2\nC=3').should.deep.equal({ A: '1', B: '2', C: '3' });
  });

  it('ignores whatever follows the closing quote on the same line', function () {
    parseEnv('A="v" # note\nB=\'w\' junk').should.deep.equal({ A: 'v', B: 'w' });
  });

  it('throws on malformed lines with the 1-based line number and content', function () {
    const badLines = [
      'JUST_A_KEY',
      '=value',
      'FOO BAR=1',
      'export',
      'KEY="unterminated',
      "KEY='unterminated",
    ];
    for (const bad of badLines) {
      const error = envError(`A=1\n${bad}\nB=2`);
      error.message.should.contain('line 2');
      error.message.should.contain(bad);
    }
  });

  it('reports the line of the fault, not line 1', function () {
    envError('A=1\nB=2\nnope here').message.should.contain('line 3');
  });
});

// ---- createConfig ----

describe('createConfig', function () {
  it('returns the schema output, coerced from env strings', function () {
    createConfig(envSchema, { PORT: '8080', VERBOSE: 'true' }).valid.should.deep.equal({
      PORT: 8080,
      VERBOSE: true,
    });
  });

  it('end-to-end: parseEnv feeds createConfig', function () {
    const { valid } = createConfig(envSchema, parseEnv('PORT=8080\nVERBOSE=true'));
    valid.should.deep.equal({ PORT: 8080, VERBOSE: true });
  });

  it('sees schema defaults when keys are absent', function () {
    createConfig(envSchema, {}).valid.should.deep.equal({ PORT: 3000, VERBOSE: false });
  });

  it('types valid as the schema output at compile time', function () {
    const cfg = createConfig(envSchema, { PORT: '8080', VERBOSE: 'true' });
    expectTypeOf(cfg.valid).toEqualTypeOf<EnvOut>();
    expectTypeOf(cfg.valid.PORT).toEqualTypeOf<number>();
    expectTypeOf<Config<typeof envSchema>>().toEqualTypeOf<{ readonly valid: EnvOut }>();
    // The schema input stays the env-string side — PORT is never a number
    // on the way in.
    expectTypeOf(envSchema).toExtend<
      StandardSchemaV1 & {
        readonly types?: {
          readonly input: { readonly PORT: string; readonly VERBOSE: string };
          readonly output: EnvOut;
        };
      }
    >();
  });

  it('throws one Error aggregating every issue with dotted paths', function () {
    let thrown: unknown;
    try {
      createConfig(brokenSchema, {});
    } catch (error) {
      thrown = error;
    }
    (thrown instanceof Error).should.be.true;
    (thrown as Error).message.should.equal(
      'config invalid:\n  PORT: expected number, got "abc"\n  db.url: required\n  boom'
    );
  });

  it('aggregates multiple env-reality failures, not just the first', function () {
    let message = '';
    try {
      createConfig(envSchema, { PORT: 'abc', VERBOSE: 42 });
    } catch (error) {
      message = (error as Error).message;
    }
    message.should.equal('config invalid:\n  PORT: expected number, got "abc"\n  VERBOSE: expected string');
  });

  it('treats an empty issues array as success', function () {
    createConfig(lenientSchema, { anything: 1 }).valid.should.equal('ok');
  });
});
