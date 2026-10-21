# OpenAPI 与工具（`s200/route-table`、`s200/meta`、`s200/openapi`、`s200/swagger`、`s200/codegen`、`s200/client`、`s200/test`）

路由表即 API 面：导出它、标注它、从中生成 OpenAPI 3.1、提供文档 UI、生成客户端、对它测试 —— 全部来自同一份普通数据。

## 路由表（`s200/route-table`）

`data + functions` 的回报：应用是普通数据，因此不做任何执行即可导出为 JSON。

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

`createRouteTable(app)` → `RouteTable`：`{ routes: readonly RouteTableEntry[] }`。

`formatRouteTable(table)` 把这张表渲染成对齐 ASCII —— `METHOD  PATTERN`，每行一条注册记录，方法列按现存最长方法名补齐（空表渲染为空字符串）。`s200 routes` 命令与开发运行器的启动报告打印的正是它。

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

`RouteMeta`：`{ summary?, description?, tags?, deprecated?, query?: Record<string, SerializeSchema>, body?: SerializeSchema, responses?: Record<number, { description: string; schema?: SerializeSchema }>, security?: ReadonlyArray<Record<string, readonly string[]>> }`。`AppMeta`：`{ title?, version?, description? }`。

`security` 即 OpenAPI 的要求形状 —— 每个条目是一个备选（OR），条目把方案名映射到其所需 scope（方案无 scope 时为 `[]`）。它原样落到 operation 上；方案本身用 `openapiSpec` 的 `securitySchemes` 选项声明。

## OpenAPI（`s200/openapi`）

OpenAPI 3.1 文档直接从路由表生成 —— 无代码生成、无执行、无模式库。每个路由变成一个 path item；`RouteMeta` 标注填充摘要、查询/体模式、安全要求与响应形状。未标注的路由仍以参数加裸 200 出现。路由链上 `throws` 闸门声明的错误分支同样变成错误 `responses`（见下）。`ALL` 路由被跳过（无单一方法可文档化），且每次构建对每个不同 pattern 警告一次 `console.warn` —— `[s200] openapi: route /x uses ALL — expand to explicit methods to document it`；动态模式路由按原样输出。

```ts
import { openapiJson } from 's200/openapi';
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // 提供 spec
const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
```

`openapiSpec` 的选项（也是 `openapiJson` 可选的第三参）是 `info` 块加两个文档级扩展：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `title` / `version` | （必填） | OpenAPI `info` 块 |
| `description` | — | `info.description` |
| `servers` | — | `ReadonlyArray<{ url: string; description?: string }>` —— 原样输出为文档的 `servers`（缺省或空数组时省略） |
| `securitySchemes` | — | `Record<string, SecuritySchemeObject>` —— 输出到 `components.securitySchemes`，供 `RouteMeta.security` 按名引用 |

`SecuritySchemeObject` 是 OpenAPI 3.1 的方案形状，刻意宽松（s200 输出数据、不做校验）：`{ type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS', description?, name?, in?, scheme?, bearerFormat?, flows?, openIdConnectUrl? }` —— `type` 之外的字段是各形态各自读取的那些。

**来自 `throws` 闸门的错误响应。** 链上带 `throws` 闸门的路由，其声明的状态码输出为错误响应。裸形式（`throws(401, 404)`）文档化默认的 `{ error: string }` 信封；记录形式（`throws({ 422: { issues: ['x'] } })`）从记录的示例值结构性推断 schema —— 字符串/布尔/null 直接映射，整数性区分 `integer` 与 `number`，元素一致时数组描述其 `items`，对象列出出现的键（示例无法知晓必选性，因此没有任何键是 `required`）。闸门与 `meta.responses` 合并不互相覆盖：只有一侧声明的状态照常输出；冲突时 **`meta.responses` 胜出** —— 它的描述与 schema 是为 spec 写的，闸门的示例只是推断种子。多个闸门声明同一状态：后注册者胜出（类型层对体形状取并集；示例值做不到）。

**schema 透传。** `toJsonSchema` 的转发覆盖 `SerializeSchema` 运行时实际携带的字段 —— `type`、`properties`/`required`、`items`、`nullable`。该 DSL 没有 `enum`/`format`/`description`/数值界标记，因此一个都不发明。

| 函数 | 含义 |
| --- | --- |
| `openapiSpec(app, options)` | `OpenApiDocument` —— `{ openapi: '3.1.0', info, servers?, components?, paths }`，构造上即 JSON 兼容 |
| `openapiJson(ctx, app, options?)` | 响应助手：spec 的 JSON 响应（`info` 字段回落到 `describeApp`；`servers`/`securitySchemes` 原样透传） |
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
| `theme` | Scalar 默认 | Scalar 主题名（`default`、`alternate`、`moon`、`kepler` …） |
| `cdn` | 钉版的 `@scalar/api-reference` 构建 | Scalar 包 URL —— 自托管镜像时覆盖 |
| `document` | Scalar CDN 外壳 | 完整 HTML 文档覆盖，**原样**输出 —— 断网环境的逃生舱：自己 vendor Scalar，让外壳指向你自己的资产。字符串，或每请求解析的 `() => string \| Promise<string>` 工厂。设置后它压过其余一切：`url`/`title`/`theme`/`cdn` 被忽略，也不做任何转义（仍是 `text/html`，带诚实的 `content-length`） |

每个插值都过 `escapeHtml`，因此恶意的 `url`/`title`/`theme` 无法逃出属性或文档。

## 代码生成（`s200/codegen`）

`generateClient(app)` 返回自包含、**带类型**的客户端模块 TypeScript 源码，由应用的**运行时**路由表加其 `s200/meta` 标注与 `throws` 声明派生 —— 无构建期插件、无反射；表即 spec。生成模块零 s200 导入：参数、路径填充、查询串与 JSON 体逻辑全部内联，因此生成文件在任何能跑 web fetch 的地方运行，`node_modules` 里无需 s200。输出是确定性的 —— 注册序、无时间戳 —— 因此可以像手写源码一样 diff 与提交。

```ts
import { generateClient } from 's200/codegen';
await writeFile('src/api/client.ts', generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' }));
```

`GenerateClientOptions`：`{ name?（默认 'createClient'）, baseUrl?, fetcherName?（默认 'fetcher'） }`。

类型的来源 —— 恰好是运行时存在的东西：

- **参数**来自每个模式：`/users/:id` → `args: { id: string }`，`/posts/:postId?` → `{ postId?: string }`，含 `*path` 通配。
- **查询**来自 `meta.query`：`init.query` 收窄为声明的键，全部可选（`{ query?: { verbose?: boolean } }`）。
- **请求体**来自 `meta.body`：`init.body` 重定型为 schema 的形状，且 `init` 变为**必填**（路由读体，调用方就必须发体）。JSON 形状的体在调用时字符串化并默认盖 `content-type: application/json`（已设置则不盖）—— s200/client 的规则；字符串与结构化体（流、blob、表单、缓冲）原样传给 fetch。
- **响应**来自 `meta.responses` 与路由的 `throws` 闸门合并（两者声明同一状态时 meta 胜出）：每个状态一个 `Branch<S, T>` 成员 —— `status` 收窄为该分支字面量、`json()` 解析为该分支体类型的 `Response` —— 因此 `if (res.status === 404)` 收窄体类型。throws 示例按结构推断，与 spec 发射器同规则。

诚实的契约：handler 自身的 `json()` 体品牌是运行时表看不见的编译期幻影 —— `meta` 与 `throws` 都未声明的东西类型为 `unknown`，完全无声明的路由保持裸 `Promise<Response>`。要直接从 handler 类型推断，请对应用本身使用 `s200/client` 的 `createClient`。

## 客户端（`s200/client`）

由应用路由表派生的类型安全 fetch 客户端 —— `data + functions` 在调用侧的回报。`createClient(app)` 在创建时为每个已注册路由构建一个路径填充函数；`Client<R>` 类型（由应用的幻影路由日志驱动）把调用限制在带类型参数的已注册模式字面量上。

```ts
import { createClient } from 's200/client';
const client = createClient(app, { baseUrl: 'https://api.example' });
const res = await client.get('/users/:id', { id: '1' });   // 带类型的参数与响应联合
const user = await (await client.get('/users/:id', { id: '1' })).json();
```

客户端发普通 `fetch` 请求（任意 base URL、任意 `fetch` 实现）并返回 Web Standard `Response` —— 不增加任何线上协议：s200 客户端可与任何讲相同模式的服务器对话，不限于 s200 应用。

`ClientOptions` 在 `baseUrl`/`fetch` 之外还有 `signal` 与 `timeoutMs`：`signal` 作用于每个请求（单次调用的 `init.signal` 在该次调用中覆盖它）；`timeoutMs` 为每个请求开启**全新的** `AbortSignal.timeout` 窗口 —— 两者同时设置时，生效信号与超时经 `AbortSignal.any` 竞速（没有该 API 的运行时手工监听联动；Node 下限 20.3 已有），复合信号以先触发者的 reason 中止。

没有 `baseUrl` 时客户端需要一个可解析的 URL 基准：浏览器与 edge 有 `globalThis.location`，相对 URL 继续可用；但在 Node 里 `createClient` 会在**创建时**抛错并提示 `options.baseUrl` —— 而不是每次请求都撞上 fetch 莫名其妙的 `TypeError`。注入的 `fetch` 自行拥有 URL 解析，因此该守卫只在未来调用全局 `fetch` 时触发。

| 函数 / 类型 | 含义 |
| --- | --- |
| `createClient(app, options?)` | `Client<R>` —— 覆盖应用路由日志的八个方法命名空间；每次调用点名一个带类型参数的已注册模式字面量 |
| `Client<R>` | 八个方法命名空间 —— `get`、`post`、`put`、`patch`、`delete`（别名 `del`）、`head`、`options` —— 各自持有该方法路由的调用签名；其他方法注册的模式类型为 `never` |
| `ClientInit` | `RequestInit & { query?: Record<string, string \| number \| boolean \| readonly (…)[] \| undefined> }` —— 数组值重复键、`undefined` 跳过、数字/布尔字符串化 |
| `ClientOptions` | `{ baseUrl?, fetch?, signal?, timeoutMs? }` —— 拼到每个路径前的 base URL；可注入 fetch 用于测试与 edge 运行时；客户端级 abort 信号；每请求超时毫秒数（与信号竞速，默认：无） |
| `ClientResponse<S, T>` | 状态判别响应联合：`res.status` 收窄 `res.json()` 的类型 |
| `BranchResponse<S, T>` | 一个分支：`{ status: S } & Response`，体类型 `T` |

路由调用签名：参数在模式捕获时（`:id`）**必填**、在模式声明时（`:id?`）**可选**、纯模式则无（`init` 前移一位）。输入幻影走同一签名：`jsonBody` 闸门类型化（并要求）`init.body`，`bodyShape<T>()` 闸门把 `init.body` 要求为声明的结构化类型（`FormData` 上传原样传给 fetch —— 不做 JSON 字符串化），`queryParams` 闸门收窄 `init.query`，`requiresHeaders` 闸门把 `init.headers` 要求为声明键必填的 `Record<string, string>`（额外键仍允许）；`throws` 闸门与返回的 `httpError` 值的错误分支在响应联合中点名错误状态。

## 测试（`s200/test`）

进程内测试原语 —— 完整应用语义（路由链、作用域中间件、`onError`/`onNotFound`、404/405/500 回退）免费提供，因为 `handle` 就是整个调度契约。

| 函数 | 含义 |
| --- | --- |
| `request(app, input, init?)` | 进程内分发一个请求 —— 测试版的 hono `app.request()`。相对字符串输入（`'/users/1'`）对 `http://s200.test` 解析；`URL` 与 `Request` 输入原样通过 |
| `testClient(app)` | 全程进程内路由的类型化 `Client`：`createClient` 配一个回环 `request` 的 fetch —— 路径填充、查询糖与幻影路由日志是真客户端的；只换了传输 |
| `probeApp(app, options?)` | 冒烟探测每个已注册路由：以模式自身保证匹配的综合路径名（捕获填 `'p' + name`）分发路由自己的方法，按注册序；`'ALL'` 路由按 `options.methodsForAll`（默认 `['GET', 'POST']`）逐方法探测 |

`ProbeRow`：`{ method, pattern, status, ok }` —— `ok` 即 `status < 500`。探测是契约而非正确性套件：每个路由必须**有应答**，参数由模式综合，因此未命中永远不会伪装成 404。测试里一次 `probeApp(app)` 调用钉住整个面。
