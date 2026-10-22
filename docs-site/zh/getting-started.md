---
# 仅站点页面（docs/ 中无源文件）——隐藏 GitHub 编辑链接。
editLink: false
---

# 快速开始

s200 是一个构建在 Web Standard 之上的数据 + 函数服务端框架 —— koa 风格洋葱中间件、hono 风格多运行时可移植，以及完全 tree-shakable、可替换的模块面。零依赖。

应用是**普通数据**，每个能力都是函数：`use(app, mw)`、`get(app, pattern, handler)`、`handle(app, request)`。没有类、没有 `new App()`、没有 `app.get(...)` —— 因此打包器可以丢掉所有未导入的能力。

本教程从零搭一个真实的 API：脚手架、路由、电池、验证、测试、OpenAPI 文档、生成的类型化客户端。每一步都可以直接复制运行；最终形态在仓库里是一个可运行的完整示例（[`examples/crud-openapi`](https://github.com/wmzy/s200/tree/main/examples/crud-openapi)）。

## 0. 前置条件

- **Node.js ≥ 20.3** 是 s200 本身的运行底线（编译后的 JavaScript）。
- 本教程（以及脚手架）用 Node 原生类型剥离直跑 `.ts` 源码。这需要 **Node ≥ 23.6 或 ≥ 22.18**（无需任何 flag）；Node 22.6–22.17 需要在命令前加 `NODE_OPTIONS=--experimental-strip-types`；更老的 Node 无法直跑 `.ts`。
- 或者干脆绕开：脚手架怎么生成都一样，任何打包工作流（vite、tsup、esbuild）都会先编译成纯 JS。
- Bun、Deno 与 edge 运行时同样支持 —— 在第 1 步选择即可（见[适配器](/zh/guides/adapters)）。

## 1. 脚手架建项目

```sh
npm create s200@latest my-api
cd my-api
npm install
```

在交互式终端里，脚手架只问一个问题：

```text
Target runtime (node/bun/deno/cloudflare):
```

跟着本教程选 `node`（非交互模式的默认值）。CI 场景有现成 flag：`--runtime node`、`--template rest`（更完整的 REST 切片；默认 `minimal`）、`--force`。

## 2. 生成的东西是什么

五个文件，没有构建步骤：

| 文件           | 是什么                                                             |
| -------------- | ------------------------------------------------------------------ |
| `app.ts`       | 应用本身 —— 普通数据加上路由注册                                    |
| `server.ts`    | 生产入口：Node 适配器的 `serve`，仅此而已                           |
| `app.test.ts`  | 基于 `node:test` 的测试，用 `s200/test` 进程内驱动 `app.ts`         |
| `package.json` | 脚本：`dev`（s200 dev）、`start`（node server.ts）、`test`          |
| `README.md`    | 模板自带的说明                                                     |

整个应用 `app.ts`：

```ts
import type { App } from 's200';

import { createApp, get, json } from 's200';

export const app: App = createApp();

get(app, '/', (ctx) => json(ctx, { hello: 'world' }));

get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
```

这就是框架的全部面：`createApp()` 返回一个普通对象，`get`（以及 `post`、`put`、`del`、`use`、…）往它的路由表里注册。没有要实例化的类，也没有插件系统 —— [路由](/zh/guides/routing)、[中间件](/zh/guides/middleware)、[响应](/zh/guides/responding) 全都是作用在这一个数据结构上的函数。`server.ts` 刻意分离 —— 应用保持运行时无关，同一个 `app.ts` 可以被[任何适配器](/zh/guides/adapters)服务：

```ts
import { serve } from 's200/node';

import { app } from './app.ts';

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`listening on ${server.url}`);
```

## 3. 开发服务器：热重载 + 404 提示

```sh
npm run dev        # 运行：s200 dev ./app.ts
```

`s200 dev` 启动时打印路由表，然后监听你的文件。保存即**原子地换掉整张路由表** —— 在途请求在旧链上跑完，新请求命中新表。进程不重启、端口不漂移。

试一下：在服务器运行时发一个打错的请求：

```sh
curl localhost:3000/helo/ada
# {"error":"Not Found","hint":"did you mean GET /hello/:name?"}
```

这就是 dev 专属的 404 路由提示中间件（默认开启；`--no-hints` 关闭）。常用 flag：`--port N`（默认 `$PORT` 或 3000）、`--host H`、`--watch DIR`（可重复）、`--env-file FILE`、`--overlay`（浏览器错误浮层）。详见[电池 · Dev / 热重载](/zh/guides/batteries)。

## 4. 加一条参数路由

编辑 `app.ts` —— 保存后开发服务器即刻生效：

```ts
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
```

```sh
curl localhost:3000/users/42
# {"id":"42"}
```

`ctx.params` 的类型来自模式字面量（这里是 `{ id: string }`），捕获值做过 percent 解码，`:id?` 可选段与 `*rest` 通配符也都如你所料 —— 细节见[路由](/zh/guides/routing)。

## 5. 加电池：CORS + 日志

电池是可选的包入口 —— 导入哪个就只拉取哪个：

```ts
import { use } from 's200';
import { cors } from 's200/cors';
import { logger } from 's200/logger';

use(app, cors({ origin: 'https://app.example', credentials: true }));
use(app, logger());
```

`cors` 就地应答预检请求、在回卷时盖章响应头 —— 连兜底的 404/500 响应也包括，因为所有响应都在链内物化。`logger` 每请求打一行（`ISO-time METHOD path status duration`），状态码永远是真实的，500 也不例外。完整的电池索引 —— auth、JWT、限流、会话、WebSocket、… —— 见[电池](/zh/guides/batteries)。

## 6. 请求体验证（Standard Schema）

`s200/validate` 不绑定任何 schema 库，但说 vendor 中立的 [Standard Schema](https://standardschema.dev) 语言：任何带 `~standard` 属性的东西都能直接塞进 `jsonBody`。下面是一个手写的最小实现 —— 零依赖，与 zod 走同一条通道：

```ts
import { post } from 's200';
import { jsonBody } from 's200/validate';
import type { StandardSchema } from 's200/validate';

type NewUser = { readonly name: string; readonly email: string };

const newUserSchema: StandardSchema<NewUser> = {
  '~standard': {
    version: 1,
    vendor: 'my-api',
    validate: (data) => {
      if (typeof data !== 'object' || data === null) {
        return { issues: [{ message: 'body must be a JSON object' }] };
      }
      const { name, email } = data as { name?: unknown; email?: unknown };
      if (typeof name !== 'string' || name.trim() === '') {
        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return { issues: [{ message: 'email must be an email address', path: ['email'] }] };
      }
      return { value: { name: name.trim(), email: email.trim().toLowerCase() } };
    },
  },
};

const users = new Map<string, NewUser>();

post(app, '/users', jsonBody(newUserSchema), (ctx) => {
  const input = ctx.state.validated as NewUser;   // schema 解析后的产物
  users.set(input.email, input);
  return json(ctx, { email: input.email }, { status: 201 });
});
```

```sh
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"ada lovelace","email":"ada@example.com"}'
# {"email":"ada@example.com"}                     — 201
curl -i -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"","email":"nope"}'                 # 422，携带第一个问题的消息
```

校验门把第一个上报的 issue 映射成单个 `422 HttpError`；非法 JSON 在 schema 运行之前就被 body 读取器以 `400` 拒绝；解析产物落在 `ctx.state.validated` 供 handler 使用。想用真正的库？`jsonBody(z.object({ … }))` —— 或 valibot、typebox、arktype —— 原样塞进同一个位置即可（见[电池 · Validate](/zh/guides/batteries)）。

## 7. 写一个测试

`s200/test` 的 `request()` 在进程内派发，带完整的应用语义 —— 路由链、路由级中间件、兜底响应。脚手架的 `app.test.ts` 已经在纯 `node:test` 上用它了；扩展一下：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { request } from 's200/test';

import { app } from './app.ts';

test('POST /users creates (201) and rejects (422)', async () => {
  const ok = await request(app, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ada', email: 'ada@example.com' }),
  });
  assert.equal(ok.status, 201);

  const bad = await request(app, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '', email: 'nope' }),
  });
  assert.equal(bad.status, 422);
});
```

```sh
npm test
```

全程不绑定任何端口。`testClient(app)` 把同样的进程内派发装进类型化客户端，`probeApp(app)` 则对每条注册路由做冒烟探测 —— 见 [OpenAPI 与工具链](/zh/api/openapi)。

## 8. 发布 API：元数据 → OpenAPI → 文档

路由表本身就是 spec —— 给它加注解，OpenAPI 文档就在运行时从中推导。没有代码生成步骤，也不需要 schema 库：

```ts
import { describeApp, describeRoute } from 's200/meta';
import { openapiJson } from 's200/openapi';
import { swaggerUi } from 's200/swagger';

describeApp(app, { title: 'My API', version: '1.0.0' });

// 在注册路由之后再 describe —— 注解以路由对象本身为键。
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  tags: ['users'],
  responses: {
    200: { description: 'the user' },
    404: {
      description: 'no such user',
      schema: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
    },
  },
});

get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'My API' }));
```

```sh
curl -s localhost:3000/openapi.json | head -c 300
# {"openapi":"3.1.0","info":{"title":"My API","version":"1.0.0"},…
open http://localhost:3000/docs      # Scalar API 参考页，零依赖
```

未加注解的路由也会带着参数和裸 200 出现 —— 路由表是事实源，元数据只是丰富它。路由链上的 `throws` 错误门也会变成文档里的错误响应。完整故事见 [OpenAPI 与工具链](/zh/api/openapi)。

## 9. 生成类型化客户端

服务 spec 的那张表同样产出客户端。一条命令：

```sh
npx s200 codegen ./app.ts --out client.ts --name createMyClient
```

或者编程式 —— `generateClient(app)` 返回 TypeScript 源码：

```ts
import { generateClient } from 's200/codegen';
await writeFile('client.ts', generateClient(app, { name: 'createMyClient' }));
```

产出的模块自包含（路径填充、query 处理、JSON body 逻辑全部内联 —— 零 s200 导入）、确定性输出（按注册序、无时间戳 —— 像手写源码一样 diff 与提交），并且**类型来自同一批注解**：参数来自每个模式、`init.body` 来自 `meta.body`、状态判别响应联合来自声明的 responses 与 `throws` 门 —— `if (res.status === 404)` 会收窄 `res.json()` 的类型。细节见 [OpenAPI 与工具链 · Codegen](/zh/api/openapi)。

这个闭环 —— **路由表 → OpenAPI → 验证 → 类型化客户端 → 测试，单一事实源** —— 就是「应用是数据」的回报。[`examples/crud-openapi`](https://github.com/wmzy/s200/tree/main/examples/crud-openapi) 是它的完整可运行版本。

## 10. 部署

`app.ts` 一个字都不用改，变的只是入口。

- **Node** —— `npm start` 已经是这个形态。生产环境再接上 `lifecycle` 做优雅排水、加一个健康检查端点：见[部署指南](/zh/guides/deployment)。
- **Bun** —— 换适配器：`import { serve } from 's200/bun'`。同一个应用，同样的路由。
- **Cloudflare Workers / Deno** —— `s200/cloudflare` 与 `s200/deno` 把 `handle(app, request)` 包进平台的事件形状；脚手架在运行时选择里都提供了。

关于生产的一切 —— Dockerfile、排水顺序、就绪闸门、绑定/host 选项 —— 都在[部署指南](/zh/guides/deployment)里。

## 接下来去哪

- 指南：[路由](/zh/guides/routing) · [中间件](/zh/guides/middleware) · [响应](/zh/guides/responding) · [请求体解析](/zh/guides/body) · [静态文件](/zh/guides/static-files)
- [电池](/zh/guides/batteries) —— cors、logger、auth、jwt、限流、WebSocket 等
- [OpenAPI 与工具链](/zh/api/openapi) —— 路由表、元数据、spec、swagger、codegen、client、test
- [API 参考](/zh/api/core) —— 每个模块的导出、签名与选项
- [错误](/zh/guides/errors) · [适配器](/zh/guides/adapters) · [包导出清单](/zh/guides/package-surface)
- [s200 与其他框架对比](/zh/comparison) · [基准测试](/zh/benchmarks) · [迁移指南](/zh/migration-from-express)
- 仓库里的可运行示例：[`examples/`](https://github.com/wmzy/s200/tree/main/examples)

完整文档同样随仓库发布在 [`docs/`](https://github.com/wmzy/s200/tree/main/docs) —— 文档站原样包含。English: [docs](/getting-started).
