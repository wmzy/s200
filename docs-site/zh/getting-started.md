# 快速开始

s200 是一个构建在 Web Standard 之上的数据 + 函数服务端框架 —— koa 风格洋葱中间件、hono 风格多运行时可移植，以及完全 tree-shakable、可替换的模块面。零依赖。

应用是**普通数据**，每个能力都是函数：`use(app, mw)`、`get(app, pattern, handler)`、`handle(app, request)`。没有类、没有 `new App()`、没有 `app.get(...)` —— 因此打包器可以丢掉所有未导入的能力。

## 安装

```sh
npm install s200
```

- Node.js ≥ 20.3 → 适配器 `s200/node`；Bun → 适配器 `s200/bun`。Deno 与 edge 运行时直接消费核心。
- 可选电池模块（`s200/cors`、`s200/logger`、`s200/validate`、…）是独立的包入口 —— 只导入用到的那个。

## Hello world

```ts
import { createApp, get, json, post, use, readJson } from 's200';
import { serve } from 's200/node';

const app = createApp();

use(app, async (ctx, next) => {
  await next();
  ctx.res?.headers.set('x-powered-by', 's200');
});

get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
post(app, '/echo', async (ctx) => json(ctx, await readJson(ctx)));

const server = await serve(app, { port: 3000 });
console.log(`listening on ${server.url}`);
```

## 下一步

- 指南：[路由](/zh/guides/routing) · [中间件](/zh/guides/middleware) · [响应](/zh/guides/responding) · [请求体解析](/zh/guides/body) · [静态文件](/zh/guides/static-files)
- [电池模块](/zh/guides/batteries) —— cors、logger、auth、jwt、rate-limit、websocket 等
- [错误](/zh/guides/errors) · [适配器](/zh/guides/adapters) · [包导出清单](/zh/guides/package-surface)
- [s200 与其他框架对比](/zh/comparison) · [基准测试](/zh/benchmarks) · [迁移指南](/zh/migration-from-express)

完整文档同样随仓库发布在 [`docs/`](https://github.com/wmzy/s200/tree/main/docs) —— 文档站原样包含。English: [docs](/).
