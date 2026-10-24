# 测试

s200 的分发是一个函数——`handle(app, request)`——这本身就是测试的全部故事。没有要启动的服务器、要分配的端口、要等待的 plugin 生命周期：用与生产相同的部件构建应用，进程内驱动，拿回真实的 Web 标准 `Response`。`s200/test` 入口打包了三个原语；下面的指南就是本仓库自己测试电池与示例的方式。

## 三个原语

| 函数 | 适用场景 |
|---|---|
| `request(app, input, init?)` | 你在测**行为** —— 一个请求穿过完整管线（作用域中间件、gate、`onError`/`onNotFound`、404/405/500 回退）。这是主力，hono `app.request()` 与 Fastify `app.inject()` 的测试等价物 |
| `testClient(app)` | 你在测**类型化往返** —— 一个 fetch 回环进 `request` 的 `createClient`，保留类型化路径/参数/请求体（`init.body`、`init.query` 幻影），只换传输 |
| `probeApp(app, options?)` | 你要一份**面契约** —— 一次调用以合成参数分发每条已注册路由，逐路由报告 `{ method, pattern, status, ok }`（`ok` 即 `status < 500`）。探测机械地钉住"每个路由都有应答"；它不是正确性套件 |

```ts
import { request, testClient, probeApp } from 's200/test';

const res = await request(app, '/users/1');       // 相对字符串对 http://s200.test 解析
const rows = await probeApp(app);                 // [{ method: 'GET', pattern: '/users/:id', status: 200, ok: true }, …]
```

`request` 接受相对字符串、`URL` 或 `Request`；`init` 是标准 `RequestInit`（method、headers、body、signal）。

## 进程内驱动完整应用

像入口文件那样组装应用——应用级中间件、路由作用域 gate、错误策略——然后驱动它。`handle` 跑的是真实链，因此一个 auth 流就是一串普通的 `request` 调用：

```ts
import { describe, expect, it } from 'vitest';
import { createApp, get, httpError, json, post, readJson, use } from 's200';
import { jwtAuth, signJwt } from 's200/jwt';
import { logger } from 's200/logger';
import { request } from 's200/test';

const SECRET = 'test-secret';
const app = createApp();
use(app, logger());                               // 生产中间件，测试里同样在

post(app, '/login', async (ctx) => {
  const { user } = await readJson<{ user: string }>(ctx);
  if (user !== 'ada') throw httpError(401, 'no such user');
  return json(ctx, { token: await signJwt({ sub: user }, SECRET) });
});
get(app, '/me', jwtAuth({ secret: SECRET }), (ctx) => json(ctx, ctx.state.jwt));

describe('the auth flow', () => {
  it('issues a token and the gate accepts it', async () => {
    const login = await request(app, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'ada' }),
    });
    const { token } = await login.json();

    const me = await request(app, '/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it('rejects an anonymous /me with 401', async () => {
    const res = await request(app, '/me');
    expect(res.status).toBe(401);
  });
});
```

这里没有伪造中间件或 gate——经 `request` 驱动 `/me` 的测试跑的正是生产那条链。

## 断言错误分支

错误是契约的一部分，而响应恒已物化——对真实的东西断言：

- **先状态码，后 body。** `res.status` 判别分支；`await res.json()` 检查信封。未处理的 `HttpError` 默认渲染 `{ status, body: { "error": message } }`；其他一切是不泄漏内部细节的通用 500（`expect(await res.json()).toEqual({ error: 'Internal Server Error' })` 形状的断言保持诚实）。
- **gate 拒绝是普通的错误分支** —— `jwtAuth` 401、`rateLimit` 429（+ `Retry-After`）、`jsonBody` 422。它们 throw 进错误边界，所以测 `onError` 策略时驱动 gate 的失败输入即可覆盖它们。
- **校验失败携带全部 issue**：校验 gate 的 422 带 `error`（首个 issue 的摘要）与带格式化路径的 `issues` 数组——`body.items.2.name: expected string, got number`。成功 body 里任何地方都没有 `issues` 键。
- **头部搭错误的车**：`httpError(401, msg, body, { 'www-authenticate': … })` 把记录合并进错误响应——像任何头部一样断言 `res.headers.get('www-authenticate')`。

```ts
it('names every invalid path', async () => {
  const res = await request(app, '/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 42 }),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { issues: { path: string }[] }).issues.length).toBeGreaterThan(0);
});
```

对类型化消费者，错误分支在声明处获得类型：`throws(401, 404)` gate 让 `s200/client` 的响应联合命名这些状态码，于是 `res.status` 收窄 `res.json()` 的类型。普通测试里用 `res.status` 判别并给 body 加 cast。

## 流、上传、超时

**流。** `request` 返回真实 `Response` —— 流式路由的 body 像任何流一样消费。`await res.text()` 排干整个泵（仓库自己的流测试就这么断言）；当断言对象是帧的*顺序*时用 `res.body.getReader()` 增量读：

```ts
const res = await request(app, '/events');
expect(res.headers.get('content-type')).toBe('text/event-stream');
const text = await res.text();                    // 排干泵：'data: 1\n\ndata: 2\n\n…'
```

**上传。** 构建 `FormData` 作为 `init.body` 传入——不需要手工合成 multipart 线上格式。原始流式 body（用手造源测 `streamForm` gate）经带 `duplex: 'half'` 的 `new Request`，再 `request(app, req)`：

```ts
const form = new FormData();
form.append('file', new Blob([bytes]), 'a.png');
const res = await request(app, '/upload', { method: 'POST', body: form });
expect(res.status).toBe(201);
```

**超时。** `timeout(ms)` gate 让链与截止时间赛跑，截止获胜时应答 503。仓库用真实、短暂的截止时间测它——一个睡过 50 ms gate 的 handler 是一个 200 ms 的测试，不需要假定时器也足够确定：

```ts
import { timeout } from 's200/timeout';

get(app, '/slow', timeout(50), async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return json(ctx, { never: 'seen' });
});
// …
expect((await request(app, '/slow')).status).toBe(503);
```

客户端取消以同样方式组合：在 `init` 里传 `AbortSignal`，handler 的 `ctx.signal` 就会触发——断连感知契约可以在进程内测试。

## Vitest 惯例

仓库自己的测试（值得照抄的风格）跑在 vitest 上，习惯如下：

- **没有 beforeEach 服务器引导。** 测试内联构建应用——常常每个测试一份——因为注册是廉价的同步数据。没有端口、没有 teardown、没有 `app.close()`。
- **经 `request(app, …)` 驱动**（核心测试里用 `handle(app, new Request(…))`）；对 `.status`、`.headers`、解析后的 body 断言。较老的套件用 `.should` 链（`res.status.should.equal(401)`），较新的用 `expect`——两种都可读；跟随你在改的文件。
- **伪造接缝，不伪造框架。** 电池把不确定性暴露为参数（`now`、`store`、`verify`、`sink`）——传假的，就不再需要定时器或网络。框架本身从不被 mock。
- **迭代时的定向运行：** `./node_modules/.bin/vitest run test/upload.test.ts`。

冒烟测试里的一次 `probeApp(app)` 加上有趣路由上的行为测试，正是各示例的平衡点：探测钉住面，行为测试钉住语义。
