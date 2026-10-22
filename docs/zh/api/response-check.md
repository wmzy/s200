# 响应契约校验（`s200/response-check`）

把文档化的响应契约放到运行时执行：`describeRoute` 收集的 `responses[status].schema` 注解 —— 也就是 [`s200/openapi`](/api/openapi) 文档化的同一批形状 —— 变成服务器真正运行的检查，在回卷（unwind）时对着已物化的响应进行。规范、文档与行为共享同一个事实源：会欺骗客户端的响应永远发不出去。

```ts
import { responseCheck } from 's200/response-check';

use(app, responseCheck(app));                        // fail：不匹配 → 500
use(app, responseCheck(app, { details: true }));     // 500 body 指名 issue 路径
use(app, responseCheck(app, {                        // 保留响应，改为上报
  onMismatch: 'report',
  onIssue: (issues, ctx) => log.warn('contract drift', { path: ctx.url.pathname, issues }),
}));

describeRoute(app, 'GET', '/users/:id', {
  responses: { 200: { description: 'ok',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
```

## 检查什么

回卷时，一个响应同时满足以下条件才会被检查：

- 它的路由匹配上了（`ctx.route` —— 404/405 回退永远不检查）；
- 路由注解为该响应的状态码声明了 schema —— 未注解的路由与状态码只付一次查找成本；
- content-type 是 JSON（`application/json`，参数忽略，或任意 `…+json` 厂商类型）；
- body 是字节背书的 —— 显式 `content-length`，与 `s200/etag` 相同的检测方式。流式响应（`s200/streaming`、SSE、chunked）跳过、绝不缓冲；无 body 响应（204/304/HEAD）同样跳过。

body 被读取一次、解析，然后用 `checkSchema`（`s200/serialize`）检查 —— 闭形状校验器，其 `additionalProperties: false` 语义与 `serialize` 的输出一致：**未声明的键就是违规**，不是噪音。声明为 JSON 的 body 解析失败本身就是根级不匹配（`{ path: [], message: 'invalid JSON body' }`）。

无论结果如何，响应都会被**逐字节原样**重建 —— 读取消耗了 body，因此相同的字节、状态与响应头（含 content-length）被写回。符合契约的响应与没有该电池时本应发出的字节完全一致。

## `ResponseCheckOptions`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `onMismatch` | `'fail'` | `'fail'`：回卷时抛 `httpError(500, 'Response schema mismatch')` —— 走正常错误映射（含 `onError`），客户端看到 500 而不是说谎的 body。`'report'`：保留响应并调用 `onIssue` |
| `details` | `false` | 把 issue 路径附到 `'fail'` 的 500 body 上：`{ error, issues: [{ path, message }, …] }`（点连接路径，根为 `''`）。**会把内部响应结构泄漏给客户端** —— 留给开发与预发环境 |
| `onIssue` | — | `(issues, ctx) => void` —— `'report'` 的接收端；收到一个响应的全部 issue 及其 ctx。`'fail'` 模式下永不调用（抛出已让失败流经 `onError`/`logError`） |

## 联动

- **`withRouteValidation`**（`s200/openapi`）：同一批注解之上的请求侧孪生。`responseCheck` 从 `ctx.route` 读取**存活**路由，因此在该变换重建路由对象后依然有效（注解被重新挂回）—— 先 describe、再 transform，两道闸都在。
- **`compress`**：把本电池注册在它**之后**（`use(app, compress()); use(app, responseCheck(app))`）—— 回卷顺序相反，校验先读到未压缩的 JSON，compress 再改写。
- **客户端类型**：本电池只是运行时契约 —— 不改变 `s200/client` 的响应类型（那是编译期 `out`/`branches` 通道的事）。

## 已知限制

- 流式与无 content-length 的 body 按设计跳过 —— 裸的 `new Response(JSON.stringify(…))` 不带显式 content-length（平台惰性序列化）；请用响应辅助函数（`json`/`jsonRaw`），它们会显式声明。
- 检查发生在回卷上，因此观察的是最终响应 —— 更外层的中间件之后仍可能改写它。
