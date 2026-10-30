/**
 * Internal cooperative-cancellation helpers behind `ctx.signal`. NOT a
 * public entry — the barrel does not re-export this module; import it
 * relatively from within src.
 *
 * @internal
 */

/**
 * The shared, never-aborted signal `ctx.signal` falls back to when neither
 * the adapter nor a middleware supplied one: one allocation per process,
 * zero per request — the memoized instance is shared and identity-compared
 * by the body-reader fast paths. It is materialized lazily because workerd
 * forbids creating signals (`AbortController` and `AbortSignal.any` alike)
 * during module evaluation ("global scope"); the first call always happens
 * inside a request handler. `AbortSignal.any([])` composes an empty set —
 * which is never aborted — and node ≥ 20.3 ships it; the `AbortController`
 * fallback guards exotic runtimes that lack it.
 */
let never: AbortSignal | undefined;

export function neverSignal(): AbortSignal {
  if (never === undefined) {
    never =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([])
        : new AbortController().signal;
  }
  return never;
}

/** The request's own `signal` when the runtime provides one — the fetch
 * handler's disconnect signal on Cloudflare Workers, always
 * present on undici requests; `undefined` on runtimes whose `Request`
 * lacks the property. */
export function requestSignal(request: Request): AbortSignal | undefined {
  return (request as { readonly signal?: AbortSignal }).signal;
}

/** `handle`'s init carrying the request's disconnect signal, when the
 * runtime provides one — `undefined` otherwise, so the shared
 * {@link neverSignal} default applies with no per-request allocation. */
export function signalInit(request: Request): { signal: AbortSignal } | undefined {
  const signal = requestSignal(request);
  return signal === undefined ? undefined : { signal };
}

/**
 * Two signals raced as one: `AbortSignal.any` where the runtime has it
 * (Node >= 20.3 — the floor), manual listener linkage elsewhere. The
 * composite aborts with the reason of whichever source aborted first —
 * pre-aborted sources are honored in argument order, and the first
 * `abort` wins, so the composite's reason is stable no matter how late
 * the second source fires. `s200/client`'s per-request timeout race
 * rides this; call it inside a request handler, never at module
 * evaluation (workerd forbids signal creation in the global scope —
 * see {@link neverSignal}).
 *
 * @internal
 */
export function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (a.aborted) {
    abort(a);
  }
  if (b.aborted) {
    abort(b);
  }
  a.addEventListener('abort', () => abort(a), { once: true });
  b.addEventListener('abort', () => abort(b), { once: true });
  return controller.signal;
}
