# 异步上下文（`s200/als`）

可选开启的请求 `Ctx` 环境访问 —— s200 显式 ctx 传递的补充，面向无法沿途传递它的调用栈。

## 环境上下文（`s200/als`）

```ts
import { als, currentCtx } from 's200/als';

use(app, als());                     // app-level: wraps the whole chain

get(app, '/x', async (ctx) => {
  await stepOne();                   // helpers need no ctx parameter
  return json(ctx, { user: currentCtx()?.state.user });
});
```

`als()` 是一个普通 `Middleware`：它把下方的一切包进平台的 `AsyncLocalStorage`（`node:async_hooks`），以请求自己的 `ctx` 为种子。`currentCtx()` 随后在被包裹范围内的任何位置解析出该 ctx —— 任意深度的 await 之后、`setTimeout` 回调里、从未收到过参数的深层工具或遗留代码中。交错的请求保持隔离（每条链跑在自己的 store 里）；请求之外 —— 中间件之前、链结束之后、响应之后才触发的定时器里 —— `currentCtx()` 是 `undefined`。注册一次、应用级即可；嵌套注册无害（内层遮蔽外层），一次注册覆盖之后挂载的路由。

storage 是模块级单例 —— 最简的形状，且可 tree-shaking：只导入 `currentCtx` 就只拉取这个入口，别无其他。

| 导出 | 含义 |
| --- | --- |
| `als()` | 包裹用的 `Middleware` —— `storage.run(ctx, () => next())`；不接受选项 |
| `currentCtx()` | `() => Ctx | undefined` —— 环境中的 ctx，被包裹的请求之外为 `undefined` |

### 运行时边界

`node:async_hooks` 存在于 **Node、Bun 与 Deno**（Node 兼容层）。**Cloudflare Workers 没有 async_hooks** —— 在那里导入 `s200/als` 会在打包/启动时失败，因此让该入口远离 edge 产物（`s200/cloudflare` 应用干脆不导入它）。显式 ctx 传递不需要回退方案：必须到处运行的代码就把 `ctx` 作为参数。
