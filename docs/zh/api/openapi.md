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

`RouteMeta`：`{ summary?, description?, tags?, deprecated?, query?: Record<string, QueryParam>, params?: Record<string, QueryParam>, headers?: Record<string, QueryParam>, cookies?: Record<string, QueryParam>, body?: SerializeSchema | MultipartBody, responses?: Record<number, { description: string; schema?: SerializeSchema }>, security?: ReadonlyArray<Record<string, readonly string[]>> }`。`AppMeta`：`{ title?, version?, description? }`。

`QueryParam` 是该参数的 `SerializeSchema` 裸形态（可选 —— 默认），或请求必须携带该键时的 `{ schema, required: true }` 标记形态。这个标记是一个 flag、三个同步视图：`openapiSpec` 输出 `parameters[].required: true`，`withRouteValidation` 对缺失的键回答 `422`（`'query.<key>: required'`），`s200/mcp` 的工具输入模式把该名字列入 `required`。`querySchemaOf(entry)`/`isQueryRequired(entry)`（来自 `s200/meta`）为自定义工具拆开两种形态。

`params` 以同样的条目形态标注路径参数 —— `/users/:id` 的 `id`：`openapiSpec` 把条目的 JSON Schema 输出为该路径参数的 schema（未标注的参数保持裸的 `{ type: 'string' }`），`withRouteValidation` 检查捕获到的值（失败时 `'params.<key>: …'`；`required` 标记拒绝可选段位的缺失）。输出的 `required` 保持段位驱动（`:id` 必填、`:id?` 可选）—— OpenAPI 把每个路径参数钉死在它填充的段位上。要用 Standard Schema 厂商跑捕获参数（或请求头）的运行时模式，见 `s200/validate` 的 `validateParams`/`validateHeaders` 闸门。

`headers`/`cookies` 以同样的条目形态标注请求头与 cookie：`openapiSpec` 把每个条目输出为 `in: 'header'`/`in: 'cookie'` 的 `parameters[]` 条目（`required` 标记随行，与 query 完全一致）。运行时两者不同：`withRouteValidation` 像 `query` 一样闸控 `headers` —— 一次大小写不敏感的 `headers.get` 读取，失败时 `'headers.<name>: …'` —— 而 `cookies` 仅文档化。解析 `cookie` 头属于 `s200/cookies`（`s200/openapi` 不得导入的入口，闸门内再造一套解析约定只会与它漂移）—— 用 cookies 电池或你自己的闸门做强制。

**multipart 请求体。** `body` 还接受 multipart 标记形态（替代 `SerializeSchema`）：`{ form: Record<string, MultipartField> }`，每个表单部件一个条目。`MultipartField` 是文本字段的 `QueryParam`（两种形态皆可）或文件标记 `{ file: true, required?, contentTypes? }` —— `required` 声明表单必须携带该部件，`contentTypes` 是文件媒体类型的允许清单：

```ts
describeRoute(app, 'POST', '/avatars', {
  summary: 'Upload an avatar',
  body: {
    form: {
      label: { schema: { type: 'string' }, required: true },
      avatar: { file: true, required: true, contentTypes: ['image/png', 'image/jpeg'] },
    },
  },
});
```

`openapiSpec` 把该路由的请求体输出为 `multipart/form-data`：

```json
"requestBody": {
  "content": {
    "multipart/form-data": {
      "schema": {
        "type": "object",
        "properties": {
          "label": { "type": "string" },
          "avatar": { "type": "string", "format": "binary" }
        },
        "required": ["label", "avatar"]
      },
      "encoding": { "avatar": { "contentType": "image/png, image/jpeg" } }
    }
  }
}
```

文件部件变成 `{ type: 'string', format: 'binary' }` —— OpenAPI 的标准文件部件拼法 —— 各带一条 `encoding` 条目：其 `contentType` 取标记的允许清单（逗号连接；规范允许清单与通配），未声明时钉死为 `application/octet-stream`（规范对 string 部件的默认是 `text/plain`，而文件部件永远不会是它）。没有文件部件的表单完全省略 `encoding`。`format: 'binary'` 的输出是设计上对 schema 透传的唯一刻意例外：它出自显式的 `file` 标记而非 schema 转换 —— `toJsonSchema` 保持只转发 `SerializeSchema` 携带的字段。`multipartFormSchema(form)`（来自 `s200/meta`）为自定义工具构建同一个 JSON Schema。`withRouteValidation` 文档化 multipart 体但不读取它 —— multipart 运行时校验（content-type、部件上限、文件允许清单）是 `s200/multipart` 的 `streamForm` / `s200/upload` 的 `uploadForm` 的职责，闸门绝不 JSON 解析请求。下游：`s200/mcp` 把表单收进一个必填 `body` 参数（JSON-RPC 参数是 JSON 而非文件部件），`s200/codegen` 把 `init.body` 类型化为 `FormData`。

`SerializeSchema` 的每个节点还接受可选 `title` —— 纯注解：`toJsonSchema` 把它带入输出的 JSON Schema，序列化与校验忽略它，spec 发射器用它命名去重后的模式（见下）。

`security` 即 OpenAPI 的要求形状 —— 每个条目是一个备选（OR），条目把方案名映射到其所需 scope（方案无 scope 时为 `[]`）。它原样落到 operation 上；方案本身用 `openapiSpec` 的 `securitySchemes` 选项声明。

## OpenAPI（`s200/openapi`）

OpenAPI 3.1 文档直接从路由表生成 —— 无代码生成、无执行、无模式库。每个路由变成一个 path item；`RouteMeta` 标注填充摘要、查询/参数/体模式、安全要求与响应形状。未标注的路由仍以参数加裸 200 出现。路由链上 `throws` 闸门声明的错误分支同样变成错误 `responses`（见下）。`ALL` 路由被跳过（无单一方法可文档化），且对每个 app 的每个不同 pattern 只警告一次 `console.warn`（进程内去重）—— `[s200] openapi: route /x uses ALL — expand to explicit methods to document it`；动态模式路由按原样输出。

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
| `refSchemas` | `true` | 传 `false` 关闭模式去重（见下），所有 schema 保持内联 |

`SecuritySchemeObject` 是 OpenAPI 3.1 的方案形状，刻意宽松（s200 输出数据、不做校验）：`{ type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS', description?, name?, in?, scheme?, bearerFormat?, flows?, openIdConnectUrl? }` —— `type` 之外的字段是各形态各自读取的那些。

**来自 `throws` 闸门的错误响应。** 链上带 `throws` 闸门的路由，其声明的状态码输出为错误响应。裸形式（`throws(401, 404)`）文档化默认的 `{ error: string }` 信封；记录形式（`throws({ 422: { issues: ['x'] } })`）从记录的示例值结构性推断 schema —— 字符串/布尔/null 直接映射，整数性区分 `integer` 与 `number`，元素一致时数组描述其 `items`，对象列出出现的键（示例无法知晓必选性，因此没有任何键是 `required`）。闸门与 `meta.responses` 合并不互相覆盖：只有一侧声明的状态照常输出；冲突时 **`meta.responses` 胜出** —— 它的描述与 schema 是为 spec 写的，闸门的示例只是推断种子。多个闸门声明同一状态：后注册者胜出（类型层对体形状取并集；示例值做不到）。`throwsErrors(route)`（来自 `s200/meta`）把链上的 `_errors` 存档合并成这份状态码 → 示例记录 —— 本发射器与 `s200/codegen` 的错误分支共用同一读取器，也可用于自定义工具。

**去重进 `components.schemas`。** 文档中出现 **≥2 次** 的任何查询/参数/体/响应模式（结构化 JSON 相等 —— 相异但等值的对象同样去重）被提升进 `components.schemas`，每个出现位置变成 `{ "$ref": "#/components/schemas/<name>" }`。名字优先取 DSL 携带的 `title`，否则按首次出现顺序合成 `Schema1`、`Schema2`、…… —— 确定性的，spec 跨构建可干净 diff；标题冲突（同 `title`、不同 JSON）经 `uniqueName(base, taken)`（来自 `s200/meta`）加 `_2`、`_3`、…… 后缀 —— 与 `s200/codegen` 的方法名、`s200/mcp` 的工具名共用的同一条后缀规则。只出现一次的模式保持内联（不做无谓碎片化），`components.securitySchemes` 与之合入同一个 `components` 对象、互不干扰。传 `refSchemas: false` 保持全部内联。

**schema 透传。** `toJsonSchema` 的转发覆盖 `SerializeSchema` 运行时实际携带的字段 —— `type`、`properties`/`required`、`items`、`nullable`、`title`。该 DSL 没有 `enum`/`format`/`description`/数值界标记，因此一个都不发明 —— 输出中唯一的 `format` 是 `binary`，由 multipart 的 `file` 标记输出（见上方「元数据」小节），绝不来自 schema 转换。

| 函数 | 含义 |
| --- | --- |
| `openapiSpec(app, options)` | `OpenApiDocument` —— `{ openapi: '3.1.0', info, servers?, components?, paths }`，构造上即 JSON 兼容 |
| `openapiJson(ctx, app, options?)` | 响应助手：spec 的 JSON 响应（`info` 字段回落到 `describeApp`；`servers`/`securitySchemes`/`refSchemas` 原样透传） |
| `withRouteValidation(app)` | 纯数据变换（mount 家族）：只重建带 `body`、`query`、`params` 或 `headers` 标注的路由，用 `s200/serialize` 的 `compileValidator` 检查请求 |

`withRouteValidation` 是 spec 的运行时孪生：违规以 `422` 应答并点名每一条违规路径 —— `error` 保留第一条（`{"error":"body.tags.1: expected string, got number"}`），`issues` 携带全量列表与按请求位置限定的路径，全部由与 `s200/validate` 共用的 `validationError` 构建器产生；合法输入不受影响地流过 —— 什么都不落 `ctx.state`、什么都不强制转换（查询值保持字符串，因此 `{ type: 'integer' }` 面对 `?page=2` 是 422 —— 想要解析请用 `s200/query` 的 `queryParams`）。标记为 required 的查询键（`{ schema, required: true }`）与 spec 同构：键缺失回答同样的 422（`{"error":"query.format: required"}`）；空值（`?format=`）算作存在，存在的值仍按其 schema 检查。`params` 条目以同样方式检查捕获到的路径参数（`'params.<key>: …'` —— 捕获值同样保持字符串）；`required` 标记拒绝可选段位的缺失（`{"error":"params.name: required"}`）。`headers` 条目以一次大小写不敏感的 `headers.get` 读取同样检查（`'headers.<name>: …'`）。两个刻意的非闸控：`cookies` 条目仅文档化（cookie 解析属于 `s200/cookies`，见上方「元数据」小节）；multipart `body` 文档化表单但不读取它 —— 闸门绝不 JSON 解析它，运行时校验归 `s200/multipart` 的 `streamForm` / `s200/upload` 的 `uploadForm`。spec 与闸门共享一个来源：标注被重新挂回重建的路由。响应侧有同样的孪生 —— [`s200/response-check`](/zh/api/response-check) 在回卷时用 `responses[status].schema` 检查已物化的响应。

## 非 TypeScript 客户端

spec 就是契约，因此任何 OpenAPI 工具链都能消费它 —— s200 自带的客户端是可选而非必需。两条官方路径，都消费 `openapiJson` 路由输出的文档：

**类型 —— [`openapi-typescript`](https://openapi-ts.dev)。** 从服务中的 spec 生成零运行时的 TypeScript 类型（与 `s200/codegen` 内建的类型同一族 `paths`/`components`，但可用于任何服务端、任何语言后端）：

```sh
npx openapi-typescript https://api.example/openapi.json -o src/api/schema.d.ts
```

```ts
import type { paths } from './api/schema.d.ts';

type User = paths['/users/{id}']['get']['responses']['200']['content']['application/json']['schema'];
```

**SDK —— [`openapi-generator`](https://openapi-generator.tech)。** 为 Python、Go、Java 与数十种语言生成完整客户端，外加服务端桩与文档：

```sh
npx @openapitools/openapi-generator-cli generate -i https://api.example/openapi.json -g python -o ./sdk-python
npx @openapitools/openapi-generator-cli generate -i openapi.json -g go -o ./sdk-go
```

`-i` 接收 URL 或已抓取的文件（`curl -o openapi.json https://api.example/openapi.json`）。对 OpenAPI 3.1 的生成器支持按生成器逐个铺开 —— 目标生成器拒绝 3.1 时，先做一次降版本转换再喂给它：

```sh
npx @apiture/openapi-down-convert --input openapi.json --output openapi-3.0.yaml
```

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
- **查询**来自 `meta.query`：`init.query` 收窄为声明的键 —— 默认可选（`{ query?: { verbose?: boolean } }`）；`{ schema, required: true }` 标记去掉 `?`（`{ query?: { format: string } }`），与 spec 的 `parameters[].required` 和闸门的 422 一致。
- **请求体**来自 `meta.body`：`init.body` 重定型为 schema 的形状，且 `init` 变为**必填**（路由读体，调用方就必须发体）。JSON 形状的体在调用时字符串化并默认盖 `content-type: application/json`（已设置则不盖）—— s200/client 的规则；字符串与结构化体（流、blob、表单、缓冲）原样传给 fetch。multipart 的 `{ form: … }` 标注把 `init.body` 类型化为 `FormData` —— 调用方构建表单，客户端原样发送。
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

`options.middleware` 是拦截器钩子 —— 认证头注入、重试、链路追踪：`ClientMiddleware[]` 按**洋葱序**排列（第一个条目是最外层）。每个条目是 `(req, next) => Promise<Response>`，作用于**完全构建好的** `Request` —— URL 已填充、查询串已拼接、JSON 体已字符串化、生效信号已盖章 —— 最内层的 `next` 就是 fetch 本身；`next` 可以被 await 多次（重试），传给它的请求也可以是重建的副本（`new Request(req, { headers })`），按次替换头、体或信号：

```ts
const authAndRetry: ClientMiddleware[] = [
  async (req, next) => {
    const headers = new Headers(req.headers);
    headers.set('authorization', `Bearer ${token}`);
    return next(new Request(req, { headers }));
  },
  async (req, next) => {
    const res = await next(req);
    return res.status === 503 ? next(req) : res;   // one bounded retry
  },
];
const client = createClient(app, { baseUrl: 'https://api.example', middleware: authAndRetry });
```

中止语义不变，且归属于**整次调用**而非单次尝试：生效信号（单次调用的 `init.signal`，否则 `signal`，再与 `timeoutMs` 竞速）只盖章一次在 `Request` 上，中止它就结束整次调用 —— 重试也不例外 —— `timeoutMs` 窗口也是每次调用一个窗口，而非每次尝试一个。想要按次限制的中间件请自行换信号（`new Request(req, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(1000)]) })`）。两个需要知道的契约：设置了 middleware 后每次调用都会先物化为 `Request` 再进链，因此**相对**路径需要一个运行时可解析的基准（`baseUrl`，或运行时的 `location`）—— 即使注入了 `fetch` 也一样 —— 绝对模式不受影响；非函数条目属于选项层的误用，在 `createClient` 时抛出并带上出错下标（与缺失 `baseUrl` 守卫同一契约）。

流式路由返回的是真正的 `Response`，`readSSE` 把它变成事件 —— 纯拉取式解析器，无需 `EventSource`：

```ts
const res = await client.get('/events');
for await (const event of readSSE(res)) {
  if (event.event === 'tick') console.log(event.data);   // 自己 JSON.parse —— data 是解码后的字符串
}
```

`ClientSseEvent` 与 `s200/streaming` 的 `SseEvent` 逐字段对齐（`{ id?, event?, data, retry? }`），`data` 恒为解码后的字符串 —— 写对象的服务端在网络上以 JSON 编码发送。解析器遵循 event-stream 规范：多行 `data` 以 `\n` 合并、注释行（`:` 开头）与未知字段名忽略、冒号后恰一个空格被剥离、LF/CRLF/孤立 CR 都终止行、开头 BOM 丢弃。`id` 与 `retry` 跨事件保留（断线重连的游标），`event` 每次分发后重置。干净结束即结束迭代（结尾不完整的半截事件丢弃）；body 读取失败（连接掉线）让 pending 的 `next()` 以该错误拒绝；中途 break 出循环会取消响应 body。

| 函数 / 类型 | 含义 |
| --- | --- |
| `createClient(app, options?)` | `Client<R>` —— 覆盖应用路由日志的八个方法命名空间；每次调用点名一个带类型参数的已注册模式字面量 |
| `Client<R>` | 八个方法命名空间 —— `get`、`post`、`put`、`patch`、`delete`（别名 `del`）、`head`、`options` —— 各自持有该方法路由的调用签名；其他方法注册的模式类型为 `never` |
| `ClientInit` | `RequestInit & { query?: Record<string, string \| number \| boolean \| readonly (…)[] \| undefined> }` —— 数组值重复键、`undefined` 跳过、数字/布尔字符串化 |
| `ClientMiddleware` | `(req: Request, next: (req: Request) => Promise<Response>) => Promise<Response>` —— 作用于完全构建好的请求的一个拦截器；最内层 `next` 是 fetch，重试时再次调用 `next` 即重新发起 |
| `ClientOptions` | `{ baseUrl?, fetch?, signal?, timeoutMs?, middleware? }` —— 拼到每个路径前的 base URL；可注入 fetch 用于测试与 edge 运行时；客户端级 abort 信号；每请求超时毫秒数（与信号竞速，默认：无）；按洋葱序的拦截器链（第一个条目最外层，非函数条目在创建时抛错） |
| `ClientResponse<S, T>` | 状态判别响应联合：`res.status` 收窄 `res.json()` 的类型 |
| `BranchResponse<S, T>` | 一个分支：`{ status: S } & Response`，体类型 `T` |
| `readSSE(response)` | `AsyncIterable<ClientSseEvent>` —— 把 `text/event-stream` 响应解析为可 `for await` 的事件：`data:`/`event:`/`id:`/`retry:` 字段、多行 data 合并、注释忽略；干净关闭结束迭代，body 掉线让 pending 的 `next()` 拒绝 |
| `ClientSseEvent` | `{ id?, event?, data, retry? }` —— 一个解析后的事件，`data` 为解码后的字符串；`id`/`retry` 跨事件保留（断线重连游标） |

路由调用签名：参数在模式捕获时（`:id`）**必填**、在模式声明时（`:id?`）**可选**、纯模式则无（`init` 前移一位）。输入幻影走同一签名：`jsonBody` 闸门类型化（并要求）`init.body`，`bodyShape<T>()` 闸门把 `init.body` 要求为声明的结构化类型（客户端按运行时的值编码：普通对象/数组会被 JSON 序列化并带上默认 `content-type: application/json`；`FormData`/`Blob`/流则原样传给 fetch），`queryParams` 闸门收窄 `init.query`，`requiresHeaders` 闸门把 `init.headers` 要求为声明键必填的 `Record<string, string>`（额外键仍允许）；`throws` 闸门与返回的 `httpError` 值的错误分支在响应联合中点名错误状态。

## 测试（`s200/test`）

进程内测试原语 —— 完整应用语义（路由链、作用域中间件、`onError`/`onNotFound`、404/405/500 回退）免费提供，因为 `handle` 就是整个调度契约。

| 函数 | 含义 |
| --- | --- |
| `request(app, input, init?)` | 进程内分发一个请求 —— 测试版的 hono `app.request()`。相对字符串输入（`'/users/1'`）对 `http://s200.test` 解析；`URL` 与 `Request` 输入原样通过 |
| `testClient(app)` | 全程进程内路由的类型化 `Client`：`createClient` 配一个回环 `request` 的 fetch —— 路径填充、查询糖与幻影路由日志是真客户端的；只换了传输 |
| `probeApp(app, options?)` | 冒烟探测每个已注册路由：以模式自身保证匹配的综合路径名（捕获填 `'p' + name`）分发路由自己的方法，按注册序；`'ALL'` 路由按 `options.methodsForAll`（默认 `['GET', 'POST']`）逐方法探测 |

`ProbeRow`：`{ method, pattern, status, ok }` —— `ok` 即 `status < 500`。探测是契约而非正确性套件：每个路由必须**有应答**，参数由模式综合，因此未命中永远不会伪装成 404。测试里一次 `probeApp(app)` 调用钉住整个面。
