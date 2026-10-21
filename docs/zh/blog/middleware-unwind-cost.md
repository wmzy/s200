# unwind 税：中间件的真实成本

你见过的每一个框架基准测试都在宣传同一件事：无中间件的下限。一个
返回 `{"message":"hello"}` 的 `GET /`、零中间件、keep-alive 客户端、
每秒请求数。这些数字是真的，但它们测量的是分发加适配器下限——而
真实的应用不是下限形状的。一个生产请求通常要 unwind 三到五个中间件
环（cors、request-id、logger、auth、cache），其中若干个想在
*处理器已经跑完之后*写一个响应头。

这次写入并不免费——它的成本取决于每个框架在你写下一行代码之前就
做出的一个架构选择：中间件在归途上碰到响应对象时，会发生什么。本文
讲清三种答案、实测的价格与如实的注意事项。完整方法论见
[基准测试](/zh/benchmarks)；逐框架的定位见[对比](/zh/comparison)。

## 下限不是你的应用

我们的 `hello`/`param` 基准行——与大多数已发表的数字一样——是
零中间件的双路由应用。它们测量路由分发与适配器下限：构造框架的
请求/响应对象、把字节交给 socket 的成本。在这个下限上，最快的
一类是避开了平台 `Request`/`Response` 构造器的框架——fastify 直接
铺 raw `IncomingMessage`，elysia 自带轻量类，hono 的默认 node
适配器把全局对象换成自己的（表中就是 `hono-patched`）。

挂上一条链，归途中盖章响应头的每一环都必须回答一个问题：*此刻响应
在哪里？* 存在三种答案，各有各的价格。

## 处理器跑完后写响应头的三种方式

**重建响应。** hono 的中间件经由上下文写头——`await next();
c.header(…)`。一旦处理器的 `Response` 存在，每次这样的写入都会
重新物化响应：每写一个头一次。五个环、五次头写入、每请求五次重建。

**原地修改响应。** s200 的链契约保证 `next()` resolve 时 `ctx.res`
已经存在——处理器响应、兜底响应（404/405/500）与错误响应全部在
链内物化。因此 s200 的环直接修改既有 `Response` 的头：
`ctx.res.headers.set(…)`。不重建、不拷贝、不经存储。同一契约也让
logger/cors/request-id 电池在 unwind 时观察并盖章*真实的*响应——
包括错误。

**先存储、后序列化。** express（`res.setHeader`）、fastify（钩子里的
`reply.header`）与 elysia（`ctx.set.headers[…]`）把头写进一个存储，
在响应最终序列化时应用。同样没有重建——但链中并不存在 Web 标准
`Response`；头搭载最后一次 flush，中间件在归途中看到的是存储，不是
响应对象。

这三种都不算作弊。它们是同一张设计网格上的不同点：谁拥有响应、它
何时存在、中间件能看到什么。但它们的价格并不相同。

## 各框架的形态

基准的 `mw` 场景在每个框架惯用的中间件里跑同一条五环链——工作量
等价（每环读取 `x-test` 请求头并设置一个响应头；第三环额外把一个
`performance.now()` 增量存进每请求上下文）但并非机械相同。事实源：
`scripts/bench-http.mjs`。

s200 —— 真正的 unwind，头写在已物化的响应上：

```js
const mwLink = (i) => (ctx, next) => {
  ctx.req.headers.get('x-test');
  return next().then(() => {
    ctx.res.headers.set(`x-mw-${i}`, String(i));
  });
};
use(
  app,
  '/mw',
  mwLink(1),
  mwLink(2),
  (ctx, next) => {
    ctx.req.headers.get('x-test');
    const t0 = performance.now();
    return next().then(() => {
      ctx.state.elapsed = performance.now() - t0;
      ctx.res.headers.set('x-mw-3', '3');
    });
  },
  mwLink(4),
  mwLink(5)
);
get(app, '/mw', (ctx) => json(ctx, { message: 'hello' }));
```

hono —— 同样是真正的 unwind，但头写入经由上下文：

```js
const mwLink = (i) =>
  app.use('/mw/*', async (c, next) => {
    c.req.header('x-test');
    await next();
    c.header(`x-mw-${i}`, String(i));
  });
mwLink(1);
mwLink(2);
app.use('/mw/*', async (c, next) => {
  c.req.header('x-test');
  const t0 = performance.now();
  await next();
  c.header('x-mw-3', '3');
  c.set('elapsed', performance.now() - t0);
});
mwLink(4);
mwLink(5);
app.get('/mw', (c) => c.json({ message: 'hello' }));
```

express —— 先存储后序列化。注意 `setHeader` 发生在*进入*途中；因为
序列化推迟到 unwind，这与在 unwind 时写入等价（第三环的计时存储仍在
`next()` 之后执行）：

```js
const mwLink = (i) => (req, res, next) => {
  req.headers['x-test'];
  res.setHeader(`x-mw-${i}`, String(i));
  next();
};
app.use('/mw', mwLink(1), mwLink(2));
app.use('/mw', (req, res, next) => {
  req.headers['x-test'];
  const t0 = performance.now();
  res.setHeader('x-mw-3', '3');
  next();
  req.elapsed = performance.now() - t0;
});
app.use('/mw', mwLink(4), mwLink(5));
app.get('/mw', (_req, res) => res.json({ message: 'hello' }));
```

fastify —— 封装 `register` 作用域里的 async `onRequest` 钩子
（fastify 钩子按插件生效），写进 reply 的头存储：

```js
await app.register(async (instance) => {
  for (let i = 1; i <= 5; i++) {
    if (i === 3) {
      instance.addHook('onRequest', async (request, reply) => {
        const t0 = performance.now();
        request.headers['x-test'];
        reply.header('x-mw-3', '3');
        request.elapsed = performance.now() - t0;
      });
    } else {
      instance.addHook('onRequest', async (request, reply) => {
        request.headers['x-test'];
        reply.header(`x-mw-${i}`, String(i));
      });
    }
  }
  instance.get('/mw', async () => ({ message: 'hello' }));
});
```

elysia —— 它的 `onRequest` 钩子无法限定作用域（对整个实例触发，
已验证），因此限定作用域的等价物是写 `set.headers` 的五环
`guard({ beforeHandle })` 链：

```js
const mwLinks = {
  beforeHandle: [1, 2, 3, 4, 5].map((i) =>
    i === 3
      ? (ctx) => {
          const t0 = performance.now();
          ctx.request.headers.get('x-test');
          ctx.set.headers['x-mw-3'] = '3';
          ctx.elapsed = performance.now() - t0;
        }
      : (ctx) => {
          ctx.request.headers.get('x-test');
          ctx.set.headers[`x-mw-${i}`] = String(i);
        }
  ),
};
app.guard(mwLinks, (scoped) => scoped.get('/mw', () => ({ message: 'hello' })));
```

## 数字

针对 2026-09-30 最终 dist 的权威运行（与参考表同一台机器——
AMD Ryzen 7 8745HS、Fedora 42——如今跑在 Node v26.10.0 上，因此
绝对数字与[基准测试](/zh/benchmarks)里的 Node 22 参考**不可比**）：

| 框架         | hello（同次运行） | mw      | mw 对 hello |
| ------------ | ---------------- | ------- | ----------- |
| s200         | 10308 req/s      | 9590    | −7%         |
| s200-light   | 14760 req/s      | 13718   | −7%         |
| hono         | 12278 req/s      | 10250   | −17%        |
| hono-patched | 17904 req/s      | 9313    | −48%        |
| express      | 11840 req/s      | 10841   | −8%         |
| fastify      | 17590 req/s      | 16681   | −5%         |
| elysia       | 16846 req/s      | 15428   | −8%         |

单个 `hello` 格逐次运行会有高达 ~±10% 的摆动——请把单格增量读作
近似值，把排序读作信号。

## 读表

`mw 对 hello` 一列正是三种模式分道扬镳的地方：

- **fastify 几乎不损失**（−5%；各次运行 ~0–5%）：它的钩子链就是向
  头存储追加的普通函数调用。下限领先在中间件下得以存活。
- **elysia 与 express 付出适度的链成本**（各 −8%）：同样的存储
  模式，每环管道稍多。
- **hono 掉了 −17%**（各次运行 −17–18%）：`await next()` 之后的
  `c.header()` 每写一个头就重新物化一次响应。
- **hono-patched 崩落 −48%**（其他运行 −46%）：patched 下限廉价，
  再没有昂贵的东西可供摊销，重建成本压过其他一切——`mw` 吞吐落到
  *低于*未 patch 的 hono（9313 对 10250）。最快的 `hello` 行变成
  最慢的 `mw` 行；mw 排序为 fastify 16681 > elysia 15428 >
  s200-light 13718 > express 10841 > hono 10250 > s200 9590 >
  hono-patched 9313。
- **s200 掉 −7%**（各次运行 −7–9%）：它像 hono 一样在处理器之后
  写头，但原地修改既有 `Response`——不重建——尽管每请求上下文更
  丰富，仍落在 express 的邻域。内置电池用的正是同一原地路径：
  request-id 经 `setHeader(ctx, …)` 盖章，在 `await next()` 之后
  就是一次直接的 `ctx.res.headers.set`。
- **s200-light 自己的下限几乎未动**（−7%，在 hello 格噪声之内），
  并在中间件负载下把 light 对正常的比值保持在 **~1.43×**：廉价的
  `LightHeaders` 写入让链叠加在一个本已廉价的响应之上几乎免费——
  尽管下限低于 patched 类，`mw` 绝对值仍居第三。

## 选型时这意味着什么

**不要为下限买单。** 如果你的应用是中间件形状的——cors 加
request-id 加 logger 加 auth 就已经是四个在 unwind 读写头的环——
hello-world 排名告诉你的是适配器，不是你的负载。hono-patched 的
~1.5× 下限在这条链下反转；fastify 的得以存活，因为它的先存储后
序列化直到最后都不碰响应对象。

**每种模式都在用速度换些什么。** 先存储后序列化快速廉价，但中间件
永远看不到真实的响应——链中没有可以读取、克隆或交给平台 API 的
Web 标准对象。重建模式保住了 Web 标准表面，却在 unwind 按头付费。
原地修改既保住 Web 标准表面、又让 unwind 写入廉价；它的价格付在
更早的地方——下限上：s200 构造平台真实的 `Response`，而这正是
patched 类避开的那笔成本（下限分解见[基准测试](/zh/benchmarks)）。

**这只是一根轴。** 吞吐量级是[对比](/zh/comparison)表里的一行。
范式、类型、电池、运行时可移植性与生态是其余各行——一个在链上慢
8% 但替你省掉一棵依赖树的框架仍然可能是正确的交易。本文的论点更窄：
知道你买的是哪种模式，因为把框架卖给你的那个基准测试多半没测过它。

## 如实说明注意事项

- **惯用而非相同。** 每个框架跑自己原生的链形态，保持工作量等价
  （相同的读取、写入和计时存储）。express 的环在进入途中写头
  （存储语义使其与 unwind 写入等价）；elysia 的限定作用域等价物是
  路由后 guard，因为它的 `onRequest` 钩子无法限定作用域。这种
  不对称正是这张表的诚实税——也是一切跨框架中间件基准的诚实税。
- **快照而非保证。** 同一台机器、先预热、每个子进程一台服务器，
  任何框架的全局打补丁都不会污染别家的行。请在你自己的硬件上重跑：
  `node scripts/bench-http.mjs --only mw`。
- **五个环是刻意的重负载。** 更短的链让每一行回到各自的下限；更重
  的链（每环更多头、体再包装）会进一步放大重建模式。
- **每环只写一个头的链仍然是友好的负载。** 它隔离的是 unwind 写入；
  它不模拟体变换、流式传输或错误路径。
