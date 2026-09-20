/**
 * Onion-model middleware composition (koa-compose semantics).
 *
 * @module
 */

import type { Ctx, Middleware, Next, Params, State } from './types';

/**
 * Composes middlewares into one callable chain. Downstream first, upstream
 * on unwind: everything before `await next()` runs in registration order,
 * everything after runs in reverse. A middleware that throws (or returns a
 * rejected promise) rejects the whole chain; calling `next()` twice before
 * it settles rejects with `Error('next() called multiple times')`.
 *
 * The optional trailing `next` continues past the last middleware into an
 * outer chain, so a composed chain is itself composable:
 * `compose([outer, compose([inner])])` runs `outer → inner → unwind`.
 */
export function compose<S extends State = State>(
  middlewares: readonly Middleware<S>[]
): (ctx: Ctx<Params, S>, next?: Next) => Promise<void> {
  return (ctx: Ctx<Params, S>, next?: Next): Promise<void> => {
    // Last index handed out; a re-entry at or below it is a double next().
    let index = -1;
    const dispatch = (i: number): Promise<void> => {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;
      const middleware = middlewares[i];
      if (middleware === undefined) {
        // i === middlewares.length: hand control to the outer chain.
        return next ? next() : Promise.resolve();
      }
      try {
        // Sync throws from non-async middleware still become rejections.
        return Promise.resolve(middleware(ctx, () => dispatch(i + 1)));
      } catch (e) {
        return Promise.reject(e);
      }
    };
    return dispatch(0);
  };
}
