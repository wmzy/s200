# Async context (`s200/als`)

Opt-in ambient access to the request `Ctx` — the supplement to s200's explicit ctx passing, for call stacks that cannot thread it.

## Ambient ctx (`s200/als`)

```ts
import { als, currentCtx } from 's200/als';

use(app, als());                     // app-level: wraps the whole chain

get(app, '/x', async (ctx) => {
  await stepOne();                   // helpers need no ctx parameter
  return json(ctx, { user: currentCtx()?.state.user });
});
```

`als()` is a plain `Middleware`: it wraps everything below it in the platform's `AsyncLocalStorage` (`node:async_hooks`), seeded with the request's own `ctx`. `currentCtx()` then resolves that ctx from anywhere inside the wrapped extent — after any number of awaits, inside `setTimeout` callbacks, in deep utility or legacy code that never saw a parameter. Interleaved requests stay isolated (every chain runs in its own store); outside a request — before the middleware, after the chain settles, in a timer fired after the response — `currentCtx()` is `undefined`. Register it once, app-level; nested registrations are harmless (the inner one shadows), and one registration covers routes mounted later.

The storage is a module-level singleton — the simplest shape, and tree-shakable: importing `currentCtx` alone pulls exactly this entry, nothing else.

| Export | Meaning |
| --- | --- |
| `als()` | The wrapping `Middleware` — `storage.run(ctx, () => next())`; takes no options |
| `currentCtx()` | `() => Ctx | undefined` — the ambient ctx, `undefined` outside a wrapped request |

### Runtime boundary

`node:async_hooks` exists on **Node, Bun, and Deno** (Node compat). **Cloudflare Workers has no async_hooks** — importing `s200/als` fails there at bundle/boot time, so keep the entry out of edge bundles (a `s200/cloudflare` app simply never imports it). Explicit ctx passing needs no fallback: code that must run everywhere takes `ctx` as a parameter.
