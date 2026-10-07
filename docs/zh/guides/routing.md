# 路由

模式使用 `:name` 参数和末尾的 `*name` 通配符。匹配默认严格（不容忍尾斜杠），先注册的胜出，`ALL` 匹配所有方法，`HEAD` 回退到 `GET` 路由。重复的捕获名（如 `/users/:id/posts/:id`）在注册时即被拒绝。捕获的值会**百分号解码**后交给处理器（`/users/foo%20bar` → `'foo bar'`）—— 与 Express/Hono 的契约一致 —— 而匹配在原始路径上运行，因此编码过的 `/` 永远伪装不成段边界。

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

`/:id?` 是可选参数 —— 该段可以省略，`ParamsOf<'/users/:id?'>` 将其类型化为 `{ id?: string }`（运行时省略缺失的键）。匹配是带回溯的贪婪匹配，因此 `/x/:a?/y` 同时匹配 `/x/y` 和 `/x/1/y`，链式可选参数从左到右解析。严格尾斜杠仍然成立：`/users/` 保留其空段，不匹配 `/users/:id?`（设置 `strict: false` 可裁掉它）。

尾斜杠严格性可按应用配置（`strict: false` 容忍 `/a/` → `/a`；默认保持严格）：

```ts
const app = createApp({ strict: false });
```

模式字面量驱动类型：`ParamsOf<'/users/:id/posts/:postId'>` 是 `{ id: string; postId: string }`，因此字面量模式处理器内的 `ctx.params` 是完整类型的。路由可以再次移除 —— `removeRoute(app, 'GET', '/users/:id')` —— 且路由表是快照不可变的：注册会替换冻结的路由/中间件数组，因此分发缓存按数组身份版本化，绝不会过期（直接对数组 `push` 会抛出异常，而不是静默破坏匹配）。路由器本身也可替换 —— 向 `createApp` 传入自定义 `match`，整个匹配策略就由你掌控：

```ts
const app = createApp({ match: myTrieMatcher });
```

分发运行在静态前缀 trie 上，按**每个**静态段建索引，而不仅是前导段：请求只访问它自身段拼出的 trie 节点，`/:tenant/resourceN` 这类路由通过后段的静态段抵达，而不是线性扫描 —— 匹配成本跟随 URL 深度，而非路由数量。残余的线性场景是完全没有静态段的路由表（`/:a/:b/:c` 风格）—— 见 `pnpm bench`。

当路径匹配但没有路由的方法匹配时，s200 回答 `405 {"error":"Method Not Allowed"}`，并带上本会匹配的方法的 `Allow` 头（RFC 9110）。中间件先运行，可以自己应答这类请求 —— CORS 预检或自定义 `OPTIONS` 处理器会在回退之前短路。

子应用挂载是纯数据变换 —— `sub` 被复制，绝不修改，其应用级中间件在挂载的路由上变为路由级：

```ts
import { mount } from 's200';

const api = createApp();
get(api, '/users/:id', handler);

const app = createApp();
mount(app, '/v1', api);   // /v1/users/:id — api itself stays reusable
```
