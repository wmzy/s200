# Serverless 适配器（`s200/aws-lambda`、`s200/vercel`）

AWS Lambda 与 Vercel 通过平台专属入口调用应用 —— 这两个适配器从 `handle` 构建该入口，同一个应用无需改动即可部署到任一平台。

## AWS Lambda（`s200/aws-lambda`）

面向 API Gateway HTTP API 与 Lambda 函数 URL —— 仅支持 payload 格式 **v2**（REST API v1 事件及其 `multiValueHeaders` 不受支持）。

```ts
// src/lambda.ts
import { createLambdaHandler } from 's200/aws-lambda';
export const handler = createLambdaHandler(app);
```

把函数入口指向 `<file>.handler` —— 函数 URL 与 HTTP API 的 Lambda 代理集成都说 v2。`createLambdaHandler(app)` 返回 `(event, context?) => Promise<LambdaResultV2>`；`context` 参数被接受但忽略（v2 结果形状用不到它）。事件/结果类型（`LambdaEventV2`、`LambdaResultV2`、`LambdaHandler`）均已导出且完全结构化 —— 不依赖 `@types/aws-lambda`。

### 事件映射

| 事件字段（v2）                 | Request 侧                                              |
| ------------------------------ | ------------------------------------------------------- |
| `requestContext.http.method`   | 请求方法                                                |
| `headers`（v2 会把名字小写化） | 请求头                                                  |
| `cookies`                      | 以 `"; "` 拼接为一个 `Cookie` 头                        |
| `host` 头                      | URL 主机（`https://` 协议；不在 authority 字符集内、或 URL 解析器无法解析的主机回退 `localhost`） |
| `rawPath` / `rawQueryString`   | URL 路径与查询串，原样透传不重编码                      |
| `body` + `isBase64Encoded`     | 请求体 —— 带标记时先 base64 解码；`body` 缺省、为 `null` 或为空串即无请求体；GET/HEAD 上的请求体被丢弃（`Request` 不接受） |

只读取上表字段 —— `routeKey`、`version` 与 `requestContext` 的其余部分原样经过、不被使用。

### 结果映射

| Response                           | 结果字段（v2）                               |
| ---------------------------------- | -------------------------------------------- |
| 状态码                             | `statusCode`                                 |
| 每条 `Set-Cookie`                  | `cookies` 数组的一项 —— 绝不合并进 `headers` |
| 其余响应头（重复项以 `", "` 合并） | 扁平 `headers` 记录                          |
| 文本类响应体                       | `body` 字符串，`isBase64Encoded: false`      |
| 其他响应体                         | base64 `body`，`isBase64Encoded: true`       |
| 空 body（204/304 等）              | 无 `body`                                    |

文本类指 `text/*`、JSON（含 `+json` 后缀）、JavaScript、XML（含 `+xml` 后缀）与 `application/x-www-form-urlencoded` —— 外加缺省 content-type。除 `identity` 之外的任何 `content-encoding` 都强制 base64：[compress](/zh/api/response-batteries) 电池的 gzip 会把文本类型变成二进制。

[`onFinish`](/zh/api/node#onfinish) 回调在适配器完成结果缓冲时运行 —— `{ aborted: false }`；只有响应体自身在中途读取失败才报 `{ aborted: true }`（并把错误重新抛给运行时）。

## Vercel（`s200/vercel`）

Edge Runtime 与 Node.js（含 Fluid Compute）都用纯 Web Standard handler 形状：

```ts
// api/index.ts
import { createVercelHandler } from 's200/vercel';
export default createVercelHandler(app);
```

`createVercelHandler(app)` → `(request: Request) => Promise<Response>` —— 以平台入口之名的 `handle`，并携带与其他边缘适配器相同的接线：运行时的请求信号（Edge Runtime 上是客户端断连）经特性检测传入 `ctx.signal`；[`onFinish`](/zh/api/node#onfinish) 回调由响应体承载 —— cancel → `{ aborted: true }`、完成 → `{ aborted: false }`，恰好一次。

Edge Runtime 用 `export const config = { runtime: 'edge' };` 选择该路由；Node.js 无需任何配置 —— 它是默认运行时。

## 限制

- Lambda：仅 payload v2 —— REST API v1 事件与 `multiValueHeaders` 不做翻译（请用 HTTP API 或函数 URL）。
- 连接升级（`s200/websocket`）需要长驻 socket，serverless 平台不提供 —— 两个适配器上升级路径均不可达。
