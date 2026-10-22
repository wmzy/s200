# MCP (`s200/mcp`)

路由表就是 API 面，因此它也就是**工具清单**：驱动 [`s200/openapi`](/zh/api/openapi) 的同一套 `describeRoute` 标注，同样驱动一个 MCP（Model Context Protocol）服务器 —— 零依赖、零会话，每个关注点一个函数。`toolManifest` 把路由编译成 MCP tool 定义，`createMcpHandler` 应答 MCP 客户端所说的 JSON-RPC 面，而每次 `tools/call` 都经 `handle` 真实往返 —— 应用的完整中间件链（auth、限流、校验门）在每次工具调用时照常运行。主流框架没有一个内置 first-class MCP 面；对 s200 来说它是数据范式的自然产物。

## 清单（`toolManifest`）

```ts
import { toolManifest } from 's200/mcp';
const { tools } = toolManifest(app);
// { tools: [{
//     name: 'get_users__id',
//     description: 'Fetch one user\n\nReturns the user by id.',
//     inputSchema: { type: 'object', properties: { id: { type: 'string' }, … }, required: ['id'] },
//   }, …] }
```

`toolManifest(app, options?)` → `McpToolManifest`（`{ tools: readonly McpTool[] }`，构造上即 JSON 兼容 —— `McpTool` 是 `{ name, description?, inputSchema }`）。默认只有带 `describeRoute` 标注的路由成为 tool；`options.includeUnannotated: true` 加入其余路由，其 `description` 回退为 `METHOD /pattern`。`description` 用空行连接 `meta.summary` 与 `meta.description`。

**Tool 名** —— 小写方法名、`_`、再去掉前导 `/` 的 pattern，并把 `[A-Za-z0-9]` 之外的每个字符一对一映射为 `_`（不折叠 —— 不同的形状保持不同）：

| 路由 | Tool 名 |
| --- | --- |
| `GET /users` | `get_users` |
| `GET /users/:id` | `get_users__id` |
| `GET /users/:id/posts` | `get_users__id_posts` |
| `GET /files/*path` | `get_files__path` |
| `GET /` | `get_` |

碰撞（方法与字母数字骨架都相同 —— 如 `/a-b` 与 `/a_b`）按注册顺序追加 `_2`、`_3`…… 因此名字保持唯一且确定。

**输入 schema** —— 一个扁平对象，三个来源按固定顺序合并（后写的组覆盖先前同名的属性，因此让参数名在来源之间保持唯一）：

1. **路径参数** —— `{ type: 'string' }`，除 `:param?` 外都 required；通配符恒为 required。
2. **Query 参数**（`meta.query`）—— 可选：query 参数在 HTTP 层永远不是必需的，且 `RouteMeta` 没有按 query 声明 required 的标记。
3. **Body**（`meta.body`）—— object schema 把自己的 `properties` 与 `required` 展平进顶层；其他形状嵌在必需的 `body` 键下。

schema 经 `toJsonSchema`（`s200/serialize`）转换 —— 与 OpenAPI 发射器同一条直通管道，覆盖 `SerializeSchema` DSL 携带的全部内容（`type`、`properties`/`required`、`items`、`nullable`）。

## 处理器（`createMcpHandler`）

```ts
import { createMcpHandler } from 's200/mcp';
const mcpHandler = createMcpHandler(app, { serverInfo: { name: 'Users API', version: '1.0.0' } });
post(app, '/mcp', (ctx) => mcpHandler(ctx.req));   // 像任何路由一样挂载
```

`createMcpHandler(app, options?)` → `(request: Request) => Promise<Response>` —— 仅接受 POST（其余一律 `405` + `Allow: POST`），最小的无状态服务器。`options.serverInfo` 默认取 `describeApp` 的 `title`/`version`，再退到 `'s200'`/`'1.0.0'`；`options.includeUnannotated` 透传给 `toolManifest`。

JSON-RPC 面：

| 方法 | 应答 |
| --- | --- |
| `initialize` | 客户端的 `protocolVersion` 属于受支持版本时原样回显，否则回最新的受支持版本；附带 `capabilities: { tools: {} }` 与 `serverInfo` |
| `tools/list` | 清单的 `tools`，不分页 |
| `tools/call` | 用 `params.name` 反查清单，重建该路由的请求 —— 路径由参数填充（逐段 percent 编码）、声明的 query 名收进 query 串（数组重复键）、body 标注的键从扁平参数中取回并作为 JSON 发送 —— 再经 `handle` 运行。应答为 `{ content: [{ type: 'text', text }], isError: status >= 400 }` |
| 通知（无 `id`） | `202 Accepted`，空 body |
| 其他 | `-32601` Method not found |

错误：body 不可读 → `-32700`；批次数组或非对象信封 → `-32600`（批处理在 `2025-06-18` 版规范中已移除）；未知 tool 名或参数缺失/非法 → `-32602`；handler 抛错 → `-32603`。畸形信封（`-32700`/`-32600`）同时报 HTTP `400`；RPC 层错误搭载 `200` —— 客户端读 body，而 body 永远是单个 `application/json` 的 JSON-RPC 对象。

在线上，`tools/call` 意味着：`get_users__id` 带 `{ "id": "7" }` 变成对应用自身的 `GET /users/7`；`post_users` 带 `{ "name": "ada" }` 变成 `POST /users` + `{"name":"ada"}`。`ALL` 路由以 `GET` 调用（且不带 body —— GET/HEAD 不能有）；其 tool 名以 `all_` 开头。

## 刻意无状态

Streamable HTTP 传输允许纯 JSON 子集，本电池实现的就是它：无论 `Accept` 头是什么，每个 POST 恰好得到一个 `application/json` 应答 —— 永不开 SSE 流、永不发放 `Mcp-Session-Id`，端点上的 `GET`/`DELETE` 一律 `405`。协商支持的版本是 `2025-06-18`、`2025-03-26`、`2024-11-05`（更新的客户端回退到 `2025-06-18`，遵循规范的「不可接受则断开」规则）；握手后的 `MCP-Protocol-Version` 头不强制 —— 没有需要保护的会话状态。清单按请求重建，因此处理器创建之后注册的路由同样被服务。

## 超出无状态子集

清单是纯数据，这便是逃逸口：需要会话、SSE 流、进度通知或 OAuth 时，把 `toolManifest(app).tools` 喂给 `@modelcontextprotocol/sdk` 的 `McpServer`（自行注册每个 tool 的 `inputSchema` 并把调用转发进 `handle`）—— 无论哪种方式，s200 始终是 tool 清单的唯一事实来源。
