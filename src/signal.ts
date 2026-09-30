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
 * zero per request. `AbortSignal.any([])` composes an empty set — which is
 * never aborted — and node ≥ 20.3 ships it; the `AbortController` fallback
 * guards exotic runtimes that lack it.
 */
export const neverSignal: AbortSignal =
  typeof AbortSignal.any === 'function'
    ? AbortSignal.any([])
    : new AbortController().signal;

/** The request's own `signal` when the runtime provides one — the fetch
 * handler's disconnect signal on Deno and Cloudflare Workers, always
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
