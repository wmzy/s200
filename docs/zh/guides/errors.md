# 错误

## 带标记的数据

错误是带标记的数据，结构化检查 —— 跨包边界没有 `instanceof` 链：

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

## 默认映射

未处理的 `HttpError` 渲染为 `{ status, body: { "error": message } }`；其他一切通过 `console.error` 记录并渲染为通用 500（绝不泄漏内部细节）。改为提供 `onError` 来拥有映射（和日志记录）—— 或只替换 sink，保留默认映射：

```ts
const app = createApp({ logError: (error) => log('error', { err: error }) });
```
