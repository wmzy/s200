import { describe, it } from 'vitest';

import { createApp } from '../src/app';
import { matchWebSocket, upgradeWebSocket } from '../src/websocket';

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
});
