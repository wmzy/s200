# OpenAPI 与工具（`s200/route-table`、`s200/meta`、`s200/openapi`、`s200/swagger`、`s200/codegen`、`s200/client`、`s200/test`）

路由表即 API 面：导出它、标注它、从中生成 OpenAPI 3.1、提供文档 UI、生成客户端、对它测试 —— 全部来自同一份普通数据。

## 路由表（`s200/route-table`）

`data + functions` 的回报：应用是普通数据，因此不做任何执行即可导出为 JSON。

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

`RouteTableEntry`：`{ method: string; pattern: string; params: readonly string[]; middlewareCount: number }` —— 参数名按捕获顺序（`:id`，然后 `*rest`）；函数本身不可序列化，因此只有中间件计数随行。便于路由清单或跨语言翻译 —— `s200/openapi` 基于同一张表构建。

## 元数据（`s200/meta`）

纯标注，存在应用之外、以路由对象为键的 `WeakMap` 里，因此核心 `App` 形状不受污染、tree-shaking 把元数据挡在每个非 OpenAPI 消费者之外。模式复用 `SerializeSchema`（`s200/serialize`）。

```ts
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: { 200: { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
```

| 函数 | 含义 |
| --- | --- |
| `describeRoute(app, method, pattern, meta)` | 标注所有注册于 `method`（规范化大写）+ `pattern` 的路由；无匹配为 no-op —— 注册后再标注 |
| `describeApp(app, meta)` | 标注应用本身（OpenAPI `info` 块） |
| `getRouteMeta(route)` / `getAppMeta(app)` | 读回已设内容 |

`RouteMeta`：`{ summary?, description?, tags?, deprecated?, query?: Record<string, SerializeSchema>, body?: SerializeSchema, responses?: Record<number, { description: string; schema?: SerializeSchema }> }`。`AppMeta`：`{ title?, version?, description? }`。

## OpenAPI（`s200/openapi`）

OpenAPI 3.1 文档直接从路由表生成 —— 无代码生成、无执行、无模式库。每个路由变成一个 path item；`RouteMeta` 标注填充摘要、查询/体模式与响应形状。未标注的路由仍以参数加裸 200 出现。`ALL` 路由被跳过（无单一方法可文档化）；动态模式路由按原样输出。

```ts
import { openapiJson } from 's200/openapi';
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // 提供 spec
const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
```

| 函数 | 含义 |
| --- | --- |
| `openapiSpec(app, info)` | `OpenApiDocument` —— `{ openapi: '3.1.0', info, paths }`，构造上即 JSON 兼容 |
| `openapiJson(ctx, app, init?)` | 响应助手：spec 的 JSON 响应 |
| `withRouteValidation(app)` | 纯数据变换（mount 家族）：只重建带 `body` 或 `query` 标注的路由，用 `s200/serialize` 的 `compileValidator` 检查请求 |

`withRouteValidation` 是 spec 的运行时孪生：违规以 `422` 应答并点名首个违规路径（`{"error":"body.tags.1: expected string, got number"}`）；合法输入不受影响地流过 —— 什么都不落 `ctx.state`、什么都不强制转换（查询值保持字符串，因此 `{ type: 'integer' }` 面对 `?page=2` 是 422 —— 想要解析请用 `s200/query` 的 `queryParams`）。spec 与闸门共享一个来源：标注被重新挂回重建的路由。

## Swagger UI（`s200/swagger`）

提供 Scalar API Reference 页面 —— 资产从钉版的 CDN 加载，因此 s200 保持零依赖：

```ts
import { swaggerUi } from 's200/swagger';
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
```

`SwaggerUiOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `url` | （必填） | OpenAPI 文档 URL —— 通常是 `openapiJson` 路由 |
| `title` | `'API Reference'` | 页面 `<title>` |
| `theme` | Scalar 默认 | Scalar 主题名（`default`、`alternate`、`moon`、`keuler` …） |
| `cdn` | 钉版的 `@scalar/api-reference` 构建 | Scalar 包 URL —— 自托管镜像时覆盖 |

每个插值都过 `escapeHtml`，因此恶意的 `url`/`title`/`theme` 无法逃出属性或文档。

## 代码生成（`s200/codegen`）

`generateClient(app)` 返回自包含客户端模块的 TypeScript 源码，由应用的**运行时**路由表派生 —— 无构建期插件、无反射；表即 spec。生成模块的唯一 s200 接触是纯类型的 `ParamsOf` 导入；路径填充与查询串逻辑内联 emitted，因此生成文件在任何能跑 web fetch 的地方运行，`node_modules` 里无需 s200。输出是确定性的 —— 注册序、无时间戳 —— 因此可以像手写源码一样 diff 与提交。

```ts
import { generateClient } from 's200/codegen';
await writeFile('src/api/client.ts', generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' }));
```

`GenerateClientOptions`：`{ name?（默认 'createClient'）, baseUrl?, fetcherName?（默认 'fetcher'） }`。

诚实的契约：路由表是运行时数据，因此不存在请求/响应体类型 —— 每个生成方法返回 `Promise<Response>`；用 `.json()`/`.text()` 读体。需要编译期体类型时，请对应用本身使用 `s200/client` 的 `createClient`。

## 客户端（`s200/client`）

由应用路由表派生的类型安全 fetch 客户端 —— `data + functions` 在调用侧的回报。`createClient(app)` 在创建时为每个已注册路由构建一个路径填充函数；`Client<R>` 类型（由应用的幻影路由日志驱动）把调用限制在带类型参数的已注册模式字面量上。

```ts
import { createClient } from 's200/client';
const client = createClient(app, { baseUrl: 'https://api.example' });
const res = await client.get('/users/:id', { id: '1' });   // 带类型的参数与响应联合
const user = (await client.get('/users/:id', { id: '1' })).json();
```

客户端发普通 `fetch` 请求（任意 base URL、任意 `fetch` 实现）并返回 Web Standard `Response` —— 不增加任何线上协议：s200 客户端可与任何讲相同模式的服务器对话，不限于 s200 应用。

| 函数 / 类型 | 含义 |
| --- | --- |
| `createClient(app, options?)` | `Client<R>` —— 每路由一个方法（`getApiV1Users` 风格命名），限制于已注册模式字面量 |
| `ClientInit` | `RequestInit & { query?: Record<string, string \| number \| boolean \| readonly (…)[] \| undefined> }` —— 数组值重复键、`undefined` 跳过、数字/布尔字符串化 |
| `ClientOptions` | `{ baseUrl?, fetch? }` —— 拼到每个路径前的 base URL；可注入 fetch 用于测试与 edge 运行时 |
| `ClientResponse<S, T>` | 状态判别响应联合：`res.status` 收窄 `res.json()` 的类型 |
| `BranchResponse<S, T>` | 一个分支：`{ status: S } & Response`，体类型 `T` |

路由调用签名：参数在模式捕获时（`:id`）**必填**、在模式声明时（`:id?`）**可选**、纯模式则无（`init` 前移一位）。输入幻影走同一签名：`jsonBody` 闸门类型化（并要求）`init.body`，`queryParams` 闸门收窄 `init.query`；`throws` 闸门与返回的 `httpError` 值的错误分支在响应联合中点名错误状态。

## 测试（`s200/test`）

进程内测试原语 —— 完整应用语义（路由链、作用域中间件、`onError`/`onNotFound`、404/405/500 回退）免费提供，因为 `handle` 就是整个调度契约。

| 函数 | 含义 |
| --- | --- |
| `request(app, input, init?)` | 进程内分发一个请求 —— 测试版的 hono `app.request()`。相对字符串输入（`'/users/1'`）对 `http://s200.test` 解析；`URL` 与 `Request` 输入原样通过 |
| `testClient(app)` | 全程进程内路由的类型化 `Client`：`createClient` 配一个回环 `request` 的 fetch —— 路径填充、查询糖与幻影路由日志是真客户端的；只换了传输 |
| `probeApp(app, options?)` | 冒烟探测每个已注册路由：以模式自身保证匹配的综合路径名（捕获填 `'p' + name`）分发路由自己的方法，按注册序；`'ALL'` 路由按 `options.methodsForAll`（默认 `['GET', 'POST']`）逐方法探测 |

`ProbeRow`：`{ method, pattern, status, ok }` —— `ok` 即 `status < 500`。探测是契约而非正确性套件：每个路由必须**有应答**，参数由模式综合，因此未命中永远不会伪装成 404。测试里一次 `probeApp(app)` 调用钉住整个面。
