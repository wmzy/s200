# Errors

Errors are tagged data, checked structurally — no `instanceof` chains across bundle boundaries:

```ts
import { httpError, isHttpError } from 's200';

throw httpError(422, 'Invalid article');

const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

Unhandled `HttpError`s render as `{ status, body: { "error": message } }`; anything else is logged via `console.error` and rendered as a generic 500 (never leaking internals). Provide `onError` to own the mapping (and the logging) instead — or just swap the sink, keeping the default mapping:

```ts
const app = createApp({ logError: (error) => log('error', { err: error }) });
```

