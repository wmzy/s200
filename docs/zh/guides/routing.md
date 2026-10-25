# 路由

## 模式基础

模式使用 `:name` 参数和末尾的 `*name` 通配符。匹配默认严格（不容忍尾斜杠），先注册的胜出，`ALL` 匹配所有方法，`HEAD` 回退到 `GET` 路由。重复的捕获名（如 `/users/:id/posts/:id`）在注册时即被拒绝。捕获的值会**百分号解码**后交给处理器（`/users/foo%20bar` → `'foo bar'`）—— 与 Express/Hono 的契约一致 —— 而匹配在原始路径上运行，因此编码过的 `/` 永远伪装不成段边界。

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

## 注册风格

函数式注册器是推荐的首选风格 —— `get(app, pattern, handler)` 以 app 为第一个参数并返回它，注册就是普通的、可 grep 的代码：

```ts
get(app, '/users/:id', getUser);
post(app, '/users', createUser);
```

`routes(app)` 是可链式的替代方案，适合分组或流式注册 —— 纯语法糖，builder 的每个方法 1:1 委托给同一批注册器并立即注册：

```ts
routes(app)
  .get('/users/:id', getUser)
  .post('/users', createUser);
```

经验法则：注册分散在多个文件或与中间件交错时用普通注册器；一组内聚路由想要流式形态时用 `routes(app)`。两者注册行为完全一致 —— 无论哪种，先注册的胜出。

## 通配符

`*name` 必须是**最后**一段 —— `/files/*path` 合法，而 `/a/*rest/b` 会在
注册时抛错（`src/router.ts` 的 `createSegments` 拒绝它：
`Invalid route pattern '…': wildcard '*rest' must be the last segment`）。
两个理由，都是刻意的：

- **捕获歧义**：路径中段的通配符没有无歧义的捕获规则。贪婪到末尾会把
  后面的 `/b` 也吞掉；懒惰匹配则让 `/a/x/y/b` 依回溯策略捕获 `x` 或
  `x/y` 之一——每个消费方都得知道是哪种。
- **索引完整性**：trie 按**每个**静态段建索引（见
  [trie 分发](#trie-分发)）。模式中段的通配符使其后的段只能靠扫描到达，
  侵蚀设计所依赖的亚微秒分发。

该规则是匹配契约的一部分——与其余路由语义一同冻结（见
[稳定性](/zh/stability)）；只在 major 中才会重新考虑。

## 可选参数与尾斜杠

`/:id?` 是可选参数 —— 该段可以省略，`ParamsOf<'/users/:id?'>` 将其类型化为 `{ id?: string }`（运行时省略缺失的键）。匹配是带回溯的贪婪匹配，因此 `/x/:a?/y` 同时匹配 `/x/y` 和 `/x/1/y`，链式可选参数从左到右解析。严格尾斜杠仍然成立：`/users/` 保留其空段，不匹配 `/users/:id?`（设置 `strict: false` 可裁掉它）。

尾斜杠严格性可按应用配置（`strict: false` 容忍 `/a/` → `/a`；默认保持严格）：

```ts
const app = createApp({ strict: false });
```

## 类型与路由表

模式字面量驱动类型：`ParamsOf<'/users/:id/posts/:postId'>` 是 `{ id: string; postId: string }`，因此字面量模式处理器内的 `ctx.params` 是完整类型的。路由可以再次移除 —— `removeRoute(app, 'GET', '/users/:id')` —— 且路由表是快照不可变的：注册会替换冻结的路由/中间件数组，因此分发缓存按数组身份版本化，绝不会过期（直接对数组 `push` 会抛出异常，而不是静默破坏匹配）。路由器本身也可替换 —— 向 `createApp` 传入自定义 `match`，整个匹配策略就由你掌控：

```ts
const app = createApp({ match: myTrieMatcher });
```

## trie 分发

分发运行在静态前缀 trie 上，按**每个**静态段建索引，而不仅是前导段：请求只访问它自身段拼出的 trie 节点，`/:tenant/resourceN` 这类路由通过后段的静态段抵达，而不是线性扫描 —— 匹配成本跟随 URL 深度，而非路由数量。残余的线性场景是完全没有静态段的路由表（`/:a/:b/:c` 风格）—— 见 `pnpm bench`。

## 方法不匹配

当路径匹配但没有路由的方法匹配时，s200 回答 `405 {"error":"Method Not Allowed"}`，并带上本会匹配的方法的 `Allow` 头（RFC 9110）。中间件先运行，可以自己应答这类请求 —— CORS 预检或自定义 `OPTIONS` 处理器会在回退之前短路。

## 子应用挂载

子应用挂载是纯数据变换 —— `sub` 被复制，绝不修改，其应用级中间件在挂载的路由上变为路由级：

```ts
import { mount } from 's200';

const api = createApp();
get(api, '/users/:id', handler);

const app = createApp();
mount(app, '/v1', api);   // /v1/users/:id — api itself stays reusable
```

子应用的 `onError` 会被携带：每个挂载路由包在一个路由级错误边界里应用它，因此子路由抛出的错误仍经子应用的策略映射（放弃处理则重新抛出，由父应用策略接管）。挂载带不走的会明说：定义了 `onNotFound` 或自定义 `match` 的子应用，每次 `mount` 调用触发一次 `console.warn` —— 挂载路由由父应用调度，运行的是父应用的 404 策略与路由器。同样会告警的还有：`strict: false` 的子应用挂到严格父应用下时，路由匹配由父应用的 matcher 决定，子应用对尾斜杠的容忍（`/users/` 命中 `/users`）随之丢失。挂载后再在 `sub` 上注册对此挂载不可见（快照语义）。
