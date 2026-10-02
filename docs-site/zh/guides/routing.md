# 路由

模式使用 `:name` 参数和末尾的 `*name` 通配符。匹配默认严格（不容忍尾斜杠；`createApp({ strict: false })` 可放宽），先注册的胜出，`ALL` 匹配所有方法，`HEAD` 回退到 `GET` 路由。捕获的值到达处理器时**已做百分号解码**（`/users/foo%20bar` → `'foo bar'`），而匹配在原始路径上运行 —— 编码过的 `/` 永远伪装不成段边界。重复的捕获名在注册时即被拒绝。

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));    // ctx.params.id: string —— 推导得出
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // 捕获其后全部内容，含 '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id 为可选参数
```

模式字面量驱动类型：`ParamsOf<'/users/:id/posts/:postId'>` 是 `{ id: string; postId: string }`，因此字面量模式处理器内的 `ctx.params` 是完整类型的 —— `/:id?` 是可选段，类型为 `{ id?: string }`。分发运行在按**每个**静态段建索引的静态前缀 trie 上，匹配成本跟随 URL 深度而非路由数量。路由也可以再次移除（`removeRoute`），路由表是快照不可变的，整个匹配器可替换（`createApp({ match: fn })`）。子应用挂载是纯数据变换：`mount(app, '/v1', api)` 复制 `api`，绝不修改它。路径匹配但方法不匹配时，回答 `405` 并带 `Allow` 头（RFC 9110）。

完整参考：[README 中的路由](https://github.com/wmzy/s200#routing)。
