# 你的路由表已经是一个 MCP server

MCP 今年成了 LLM 集成的事实标准——TypeScript SDK 到了 v2 stable，
框架横评已经开始把 MCP 支持列为对比维度。常见答案是外挂一个 server
包：把每个端点重新描述第二遍（描述成 tool），然后靠自觉让两份描述
保持同步。s200 的答案更小：你为 [OpenAPI](/zh/api/openapi) 写的
`describeRoute` 注解就是 tool 列表。一批数据、读两次——没有额外
注解、没有会话、没有依赖。本文走完整条路：什么会流出来、一次
tool 调用如何变成真实请求、以及无状态设计刻意停在哪里。

## 你已经写过的那些注解

下游的一切都从这里开始——一张路由表加元数据，全是纯数据，没有
装饰器也没有代码生成：

```ts
import { createApp, get, post } from 's200';
import { describeApp, describeRoute } from 's200/meta';

const app = createApp();

get(app, '/users/:id', (ctx) => { /* … */ });
post(app, '/users', (ctx) => { /* … */ });

describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  description: 'Returns the user by id.',
  query: { verbose: { schema: { type: 'boolean' } } },
  responses: {
    200: {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
});
describeRoute(app, 'POST', '/users', {
  summary: 'Create a user',
  body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  responses: { 201: { description: 'created' } },
});
```

`s200/openapi` 把这些原样变成一份 OpenAPI 3.1 文档——`openapiSpec(app)`
遍历路由表，把 `SerializeSchema` DSL 转成 JSON Schema，把重复的形状
去重进 `components.schemas`。下面的一切都以这个 emitter 为参照点，
因为 `s200/mcp` 跑的是同一次遍历、同一次转换。

## 同一份数据，读成 tool

```ts
import { toolManifest } from 's200/mcp';
const { tools } = toolManifest(app);
// { tools: [{
//     name: 'get_users__id',
//     description: 'Fetch one user\n\nReturns the user by id.',
//     inputSchema: { type: 'object', properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
//                    required: ['id'] },
//   }, {
//     name: 'post_users',
//     description: 'Create a user',
//     inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
//   }] }
```

每个带注解的路由变成一个 tool。slug 是机械的：小写方法、`_`、
然后把 pattern 里 `[A-Za-z0-9]` 之外的每个字符一一映射成 `_`——
`GET /users/:id` 变 `get_users__id`，`GET /files/*path` 变
`get_files__path`。不折叠，所以不同形状保持不同；真正的冲突
（同方法同字母数字骨架，比如 `/a-b` 与 `/a_b`）按注册顺序追加
`_2`、`_3`、…。默认跳过未注解的路由——注解就是契约，所以按路由
决定是否暴露；`{ includeUnannotated: true }` 把其余路由也暴露出来，
它们的 description 退回 `METHOD /pattern`。

输入 schema 是按固定顺序从三个来源合并成的一个扁平对象：

1. **路径参数**——`{ type: 'string' }`，除非段是 `:param?` 否则
   必填；通配符恒必填。
2. **查询参数**——来自注解；默认可选，但 `{ schema, required: true }`
   标记形态会把名字列进 `required`。这个标记是一个带三个同步视图
   的开关：`openapiSpec` 发出 `parameters[].required: true`，校验
   闸门对缺失的键应答 422，tool schema 把参数标成必填。tool 调用方
   不可能被告知一个 spec 并不要求的参数。
3. **请求体**——对象 schema 把它的 `properties` 和 `required` 平铺
   到顶层；其他形状嵌套在一个必填的 `body` 键下。multipart
   `{ form: … }` 注解也这样嵌套——JSON-RPC 参数是 JSON 不是文件
   part，所以表单退化成一个携带自身形状的 `body` 参数。

schema 经 `toJsonSchema`（`s200/serialize`）转换——与 OpenAPI
emitter 用的是同一个直通转换。这就是两个 battery 之间的全部关系：
不是把共享代码硬接到两种格式上，而是一个注解存储被两个消费者读。
文档与 tool 不会漂移，因为谁都没有属于自己的第二份描述。

## 挂载 server

```ts
import { post } from 's200';
import { createMcpHandler } from 's200/mcp';

const mcpHandler = createMcpHandler(app, {
  serverInfo: { name: 'Users API', version: '1.0.0' },
});
post(app, '/mcp', (ctx) => mcpHandler(ctx.req));
```

这就是整个 server。`createMcpHandler` 返回
`(request: Request) => Promise<Response>`——一个函数，挂在你任意
选的 POST 路由后面，由包裹它的任何中间件守卫。它应答的 JSON-RPC
表面：

| 方法 | 应答 |
| --- | --- |
| `initialize` | 请求的 `protocolVersion` 是受支持的修订之一时回显它，否则以最新版应答；`capabilities: { tools: {} }` 与 `serverInfo` 随行 |
| `tools/list` | manifest 的 `tools`，无分页 |
| `tools/call` | 解析 `params.name`、重建该路由的请求、经 `handle` 运行——见下 |
| 通知（无 `id`） | `202 Accepted`，空主体 |
| 其他 | `-32601` Method not found |

`serverInfo` 默认取 `describeApp` 的 `title`/`version`——应用自身
的元数据被第三次读取——再退到 `'s200'`/`'1.0.0'`。协商的协议修订
是 `2025-06-18`、`2025-03-26` 与 `2024-11-05`；更新的客户端拿回
`2025-06-18`，无法接受就断开——这正是 spec 自己的协商规则。

## 每次 tool 调用都是真实请求

值得理解的部分是 `tools/call`。handler 对照 manifest 解析 tool 名，
重建该调用所代表的 HTTP 请求——路径从参数填充（每段 percent
编码）、声明的查询名收进查询串（数组重复键）、请求体注解的键从
扁平参数里挑回去并以 JSON 发送——然后经 `handle` 运行，也就是
应用自己的分发契约。

在线上，带 `{ "id": "7" }` 的 `get_users__id` 变成对应用自身的
`GET /users/7`；带 `{ "name": "ada" }` 的 `post_users` 变成带
`{"name":"ada"}` 的 `POST /users`。而且因为应答的是应用本身，
**完整的中间件链在每次 tool 调用时照常运行**——auth、限流、校验
闸门。MCP 客户端只是另一个客户端，而且意图未必比浏览器善良：它
拿不到旁路，它会像 curl 一样诚实地拿到你的 401 和 429。应答形状
是 MCP 的标准信封：
`{ content: [{ type: 'text', text }], isError: status >= 400 }`。

错误干净地映射到 JSON-RPC：读不了的请求体是 `-32700`；批次数组
或非对象信封是 `-32600`（批处理在修订 `2025-06-18` 里已从 spec
移除）；未知 tool 名或缺必填参数是 `-32602`；抛错的 handler 是
`-32603`。

## 无状态，以及它买到什么

Streamable HTTP 传输允许一个纯 JSON 子集，而发布的就是这个子集：
每个 POST 无论 `Accept` 头是什么都得到恰好一个 `application/json`
应答——永不打开 SSE 流、永不签发 `Mcp-Session-Id`，端点上的
GET/DELETE 应答 405。没有需要保护的会话状态，所以握手后的
`MCP-Protocol-Version` 头也不强制。

无状态有两个实际收益。第一，manifest 每次请求重建（遍历很便宜——
几十条路由），所以 handler 创建之后注册的路由也能被服务到；你永不
发布过期的 tool 列表。第二，重启或负载均衡之下没有任何会坏掉的
东西——任何实例应答任何调用。

当无状态子集不够用时，manifest 是纯数据，这就是逃生舱：把
`toolManifest(app).tools` 喂给 `@modelcontextprotocol/sdk` 的
`McpServer`（自己注册每个 tool 的 `inputSchema`、自己经 `handle`
转发调用），当你需要会话、SSE 流、进度通知或 OAuth。无论哪种方式
s200 都是 tool 列表的事实源——SDK 构建同样从这批注解出发，而不是
从第二份描述出发。

这就是全部的故事：主流框架今天没有一个自带一等 MCP 表面，而 s200
有的原因不是它在 MCP 上更努力——它从不需要把 API 描述第二遍。路由
表本来就在；注解本来就在；tool 列表只是它们从侧面看过去的模样。
完整表面见 [MCP API 参考](/zh/api/mcp)；注解存储本身见
[OpenAPI 与工具链](/zh/api/openapi)。
