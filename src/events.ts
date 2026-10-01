/**
 * Typed event bus battery: a thin, per-key-typed facade over the
 * `@for-fun/event-emitter` primitives. The library's emitter is a plain
 * `Map` (pure data — its published type is only a phantom brand); this
 * module hands back a bundle of functions bound to it, no class involved.
 *
 * Error contract, shared by `emit` and `emitAsync` — synchronous error
 * COLLECTION, not fail-fast: a listener that throws (or, for `emitAsync`,
 * returns a rejected promise) never stops its peers. Once the fan-out
 * completes, every collected error is routed through the `onError`
 * channel in listener order; when no `onError` subscriber exists, the
 * first collected error is rethrown to the emit caller (or rejects the
 * `emitAsync` promise) instead of being swallowed.
 *
 * @module
 */

import {
  create as createEmitter,
  emit as emitEvent,
  emitError as emitErrorEvent,
  off as offEvent,
  on as onEvent,
  onError as onErrorEvent,
  setMaxListeners as capListeners,
  type EventEmitter,
  type Handler,
} from '@for-fun/event-emitter';

/** Event name → its listener argument tuple. */
export type EventsMap = Record<string, unknown[]>;

/**
 * The library's ET union for an {@link EventsMap}: one `[key, args]` tuple
 * per event. This is the bridge that connects `M` to the library's
 * generics — for every concrete `M` its `Key` resolves to `keyof M` and
 * its `Param` to `M[K]`, which is exactly what the {@link Bus} signatures
 * spell out (the library keeps `Key`/`Param` private, so they are
 * mirrored, not derived).
 */
type EventTuples<M extends EventsMap> = {
  [K in keyof M & string]: [K, M[K]];
}[keyof M & string];

/**
 * A typed bus: the library's per-function API re-exposed as one bundle of
 * bound functions.
 */
export type Bus<M extends EventsMap> = {
  /**
   * Subscribes to `key`; returns the unsubscribe function (the same
   * function `off(key, handler)` removes).
   */
  readonly on: <K extends keyof M & string>(
    key: K,
    handler: (...args: M[K]) => unknown
  ) => () => void;
  /**
   * Subscribes for a single delivery: the listener removes itself before
   * it runs (so a re-entrant `emit` from inside it will not re-deliver).
   */
  readonly once: <K extends keyof M & string>(
    key: K,
    handler: (...args: M[K]) => unknown
  ) => () => void;
  /**
   * Without arguments clears everything (the error channel included);
   * with a key drops all of that key's listeners; with key + handler
   * removes just that one subscription.
   */
  readonly off: <K extends keyof M & string>(
    key?: K,
    handler?: (...args: M[K]) => unknown
  ) => void;
  /**
   * Synchronous fan-out in registration order. Errors are collected, not
   * fail-fast: a throwing listener never stops its peers; afterwards every
   * collected error goes through the `onError` channel in listener order,
   * or — with no subscriber — the first collected error is rethrown to
   * this caller. An `onError` handler that itself throws propagates to
   * the emit caller (library semantics).
   */
  readonly emit: <K extends keyof M & string>(
    key: K,
    ...args: M[K]
  ) => void;
  /**
   * The async twin of {@link Bus.emit}: invokes the listeners of the set
   * as of this call synchronously, collects their returned values, and
   * resolves only once every one of them has settled (allSettled
   * semantics). Sync throws and async rejections are collected alike and
   * routed through the same `onError` channel in listener order; with no
   * subscriber the promise rejects with the first collected error.
   */
  readonly emitAsync: <K extends keyof M & string>(
    key: K,
    ...args: M[K]
  ) => Promise<void>;
  /**
   * Subscribes to the shared error channel both emit flavors route
   * through; returns the unsubscribe function.
   */
  readonly onError: (handler: (err: Error) => void) => () => void;
  /**
   * Raises or lowers the per-key listener-leak warning ceiling; `0`
   * silences it. Purely diagnostic — never blocks a subscription.
   */
  readonly setMaxListeners: (maxListeners: number) => void;
};

/** Options for {@link createBus}. */
export type BusOptions = { readonly maxListeners?: number };

/**
 * The untyped view the implementation bodies run against — every key is a
 * plain string, every args tuple a plain unknown[].
 */
type BusFns = {
  readonly on: (key: string, handler: (...args: unknown[]) => unknown) => () => void;
  readonly once: (key: string, handler: (...args: unknown[]) => unknown) => () => void;
  readonly off: (key?: string, handler?: (...args: unknown[]) => unknown) => void;
  readonly emit: (key: string, ...args: unknown[]) => void;
  readonly emitAsync: (key: string, ...args: unknown[]) => Promise<void>;
  readonly onError: (handler: (err: Error) => void) => () => void;
  readonly setMaxListeners: (maxListeners: number) => void;
};

/**
 * Creates a typed event bus. The listeners' parameters and the emit
 * arguments are narrowed per key by `M`; see {@link Bus} for the error
 * routing contract shared by `emit` and `emitAsync`.
 */
export function createBus<M extends EventsMap>(options?: BusOptions): Bus<M> {
  const emitter = createEmitter<EventTuples<M>>();
  if (options !== undefined && options.maxListeners !== undefined) {
    capListeners(emitter, options.maxListeners);
  }
  // Implementation seam: while `M` is abstract, TS cannot reduce the
  // library's Key/Param conditionals over `EventTuples<M>`, so the bodies
  // below talk to the emitter through concrete string/unknown[] views —
  // against those, every library call type-checks with zero argument
  // casts. The public surface is attached by one identity cast at the
  // end: for every concrete `M`, `Key<EventTuples<M>>` is `keyof M` and
  // `Param<EventTuples<M>, K>` is `M[K]`, so widening `Bus<M>` to
  // {@link BusFns} loses nothing the callers rely on.
  const view = emitter as unknown as EventEmitter<[string, unknown[]]>;
  // The emitter's runtime body is the Map itself (its published type is
  // only a phantom brand); emitAsync reads the listener set the same way
  // the library's own emit does.
  const table = emitter as unknown as Map<PropertyKey, Set<Handler<unknown[]>>>;
  const fns: BusFns = {
    on: (key, handler) => onEvent(view, key, handler),
    once: (key, handler) => {
      // Library once semantics — the listener is gone before it runs —
      // but the wrapper keeps the return value flowing so `emitAsync`
      // can await once-listeners too (the library's own `once` drops it).
      const off = onEvent(view, key, (...args) => {
        off();
        return handler(...args);
      });
      return off;
    },
    off: (key, handler) => {
      if (key === undefined) {
        offEvent(view);
        return;
      }
      offEvent(view, key, handler);
    },
    emit: (key, ...args) => {
      emitEvent(view, key, ...args);
    },
    emitAsync: async (key, ...args) => {
      const set = table.get(key);
      const results: Promise<unknown>[] = [];
      if (set !== undefined) {
        // Live-set iteration like the library's emit: a listener removed
        // before its turn is skipped, one added during the loop still
        // gets this delivery.
        set.forEach((handler) => {
          try {
            results.push(Promise.resolve(handler(...args)));
          } catch (err) {
            // Sync throws become rejections so a single slot-aligned
            // allSettled pass covers both — errors then surface in
            // listener order, the same collection order emit uses.
            results.push(Promise.reject(err));
          }
        });
      }
      const outcomes = await Promise.allSettled(results);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // With no onError subscriber this throws on the first
          // collected error, and the throw rejects the returned promise —
          // the same routing contract as emit.
          emitErrorEvent(view, outcome.reason as Error);
        }
      }
    },
    onError: (handler) => onErrorEvent(view, handler),
    setMaxListeners: (maxListeners) => {
      capListeners(emitter, maxListeners);
    },
  };
  return fns as unknown as Bus<M>;
}
