# 别发布说谎的响应：运行时契约检查

你的 API 文档做了一个承诺：这个端点以 200 应答一个带 `id` 的对象。
基于这份文档构建的每一个集成、每一个 SDK、每一个 LLM tool 都继承
这个承诺——而 handler 一旦发布了 `{ ident: 7 }`，承诺就悄无声息地
碎了。在响应发布前对照 schema 检查它们，这个想法并不新；新的是在
主流 Node 框架里你要为此等多久。fastify 把"序列化前用 Ajv 校验
响应"放进了 v6 里程碑，而截至 2026 年 10 月下旬那条线仍停在
`6.0.0-alpha.5`；hono 的 v5——本身还在 RC——把响应校验列为 v5
特性。s200 的 [`response-check`](/zh/api/response-check) battery
今天就覆盖这一轴，落在 `SerializeSchema` 契约上；本文展示实施它实际
需要什么：一份你已有的注解、一个中间件、一个刻意收窄的范围。

## 契约是你已有的数据

s200 的响应契约与其他一切住在同一个注解存储里——就是驱动
[OpenAPI 3.1 文档](/zh/api/openapi)的那份 `describeRoute` 元数据：

```ts
import { createApp, describeRoute, get, json, use } from 's200';
import { responseCheck } from 's200/response-check';

const app = createApp();

get(app, '/users/:id', (ctx) => json(ctx, { id: Number(ctx.params.id) }));
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: {
    200: {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
});

use(app, responseCheck(app));
```

接线就这些。`responses[200].schema` 本来就是 `openapiSpec` 文档化的
东西；现在服务器也强制它了。spec、文档与行为的事实源只有一个——
`withRouteValidation` 给请求侧的性质，镜像到了响应侧。

## 检查什么——以及刻意不检查什么

检查发生在 unwind，针对已物化的响应，所以它看到的正是客户端
将收到的内容。一个响应仅当以下全部成立时才被检查：

- 它的路由匹配上了（`ctx.route`——404/405 兜底永不检查）；
- 路由的注解为响应的实际状态声明了 schema——未注解的路由与
  状态只付一次查找；
- content-type 是 JSON（`application/json`，参数忽略，或任何
  `…+json` vendor 类型）；
- 请求体是字节背书的——显式 `content-length`，与 `s200/etag`
  用的同一检测。流式响应（`s200/streaming`、SSE、chunked）被
  跳过、绝不缓冲；无体响应（204/304/HEAD）同样。

最后一条是契约，不是要绕过的限制：respond 助手（`json`、
`jsonRaw`）给出显式 `content-length`，所以正常的 JSON 路由总是
可检查的；而裸的 `new Response(JSON.stringify(…))`——平台惰性
序列化它、没有 content-length——原样通过不检查。想检查某条路由，
就用助手写它。

响应被检查时，请求体读取一次、解析一次，用 `checkSchema`
（`s200/serialize`）校验——那个闭形校验器，它的
`additionalProperties: false` 读法与 `serialize` 在输出侧发出的
完全一致：**未声明的键是违规**，不是噪音。声称 JSON 却发布了别的
东西的请求体本身就是根级失配（`{ path: [], message: 'invalid JSON
body' }`）——一个谎称 JSON 的响应与任何类型错误一样破坏契约。

无论结果如何，响应都被**逐字节**重建——读取消耗了请求体，所以
同样的字节、状态与头（含 content-length）被写回。合规响应与没有
这个 battery 时会发布的字节完全一致；正常路径上没有"被检查过"
的税。

## 大声失败，或安静上报

```ts
use(app, responseCheck(app));                        // fail (default): mismatch → 500
use(app, responseCheck(app, { details: true }));     // 500 body names the issue paths
use(app, responseCheck(app, {                        // keep the response, report instead
  onMismatch: 'report',
  onIssue: (issues, ctx) => log.warn('contract drift', { path: ctx.url.pathname, issues }),
}));
```

`'fail'` 默认在 unwind 抛 `httpError(500, 'Response schema
mismatch')`——经正常的错误映射，所以你的 `onError` 策略应答它，
客户端看到 500 而不是说谎的体。`details: true` 把问题路径附到
那个 500 体上（`{ error, issues: [{ path, message }, …] }`）——
留给开发与预发环境，因为这些路径点名了你未必想公开的内部响应
结构。`'report'` 保留响应并把每个问题交给 `onIssue`——漂移检测
模式：你的仪表盘在客户端之前得知契约正在漂移。

两条值得知道的配合规则：

- **与 `compress` 一起用时**，把检查注册在它之后
  （`use(app, compress()); use(app, responseCheck(app))`）——
  unwind 反向运行，所以检查在 compress 改写之前读到未压缩的
  JSON。
- **与路由变换一起用时**，检查刻意从 `ctx.route` 读*活体*路由
  而不在创建时捕获任何东西——`withRouteValidation` 会重建路由
  对象（重新挂注解），捕获的路由会过期。描述、变换与两道闸门
  一起保持有效。

## 如实的局限

- 检查在 unwind 运行，所以它观察的是最终响应——更外层注册的
  中间件之后仍可能改写它。
- 它是运行时契约，不是类型层：它永不改变 `s200/client` 调用方
  看到的类型（那是编译时通道），也不为 handler 的返回值定型。
- 只检查 JSON，这是设计——HTML、二进制与流式表面没有
  `SerializeSchema` 契约可强制。

值得带走的框架：响应校验多年来一直是路线图条目，因为主流框架
没有"文档化的契约"单独存在的地方——它得先在路由定义、序列化器
与 spec emitter 之间完成对齐。s200 里这种对齐在注解存储里做过
一次，运行时闸门就是从那里掉出来的。完整表面见 API 参考：
[`s200/response-check`](/zh/api/response-check)；与它共享数据的
请求侧孪生与 spec emitter 见 [OpenAPI 与工具链](/zh/api/openapi)。
