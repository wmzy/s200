# 中间件

中间件是 `async (ctx, next)`，具有 koa 洋葱语义 —— `await next()` 之后的代码在 unwind 时运行，异常向外传播，第一次 `next()` 未 settle 前再次调用 `next()` 会拒绝。不调用 `next()` 会跳过其下一切，包括处理器。

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.res?.headers.set('x-duration', String(performance.now() - start));
});
```

`ctx.state` 是每个请求全新的可变包 —— 中间件与处理器之间的类型化传递通道。可通过声明合并按应用扩展其类型（`declare module 's200' { interface State { user: User } }`），或在应用之间不得共享同一全局形状时给 `createApp` 传入逐应用的接口。

`await next()` settle 后，`ctx.res` 总是已物化 —— 处理器的响应、404/405/500 回退，**或错误响应**：链内的错误边界在 unwind 前映射抛出的错误，因此中间件可以观察（并可覆盖）真实响应，包括 500。路由也接受作用域中间件（模式与末端处理器之间的任意数量），`use(app, '/admin', requireAuth)` 将一个组限定在段边界感知的前缀上。

完整参考：[README 中的中间件（洋葱）](https://github.com/wmzy/s200#middleware-onion)。
