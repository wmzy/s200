# 编写 Battery

battery 是 s200 复用中间件的基本单元：一个位于独立包入口（`s200/cors`、`s200/validate`、…）之后的可选模块，零运行时依赖，由纯函数构成——选项进、`Middleware` 出。内置 battery 是范本，核心 barrel 里的 `defineMiddleware` 则是打包你自己的 battery 的正式入口。本指南会依次讲两种运行时形态、流入 `s200/client` 的类型品牌、内置 battery 的结构约定，以及如何发布。想纵览当前已内置的内容，请看 [battery 总览](https://github.com/wmzy/s200#batteries)。

## battery 是什么

每个 battery 都遵守四条规则，无论内置还是自建：

1. **独立入口。** `import { cors } from 's200/cors'` 只拉取一个模块，绝不会拉到核心 barrel。在本仓库中，这是一个源文件（`src/cors.ts`）接成一条构建入口；在你自己的包里，它是一个子路径导出。
2. **零运行时依赖。** 框架本身就没有依赖，battery 也不得引入任何依赖。其余一切都基于 Web 标准（`Request`、`Headers`、`crypto.subtle`、`CompressionStream`、`performance.now()`），或由调用方注入——schema、存储、时钟、验证器、输出端。
3. **纯函数。** 工厂函数接收一个选项对象并返回一个 `Middleware`。没有模块级注册副作用，没有类，没有 `this`——应用即数据，battery 就是再产出其中一块数据的函数。
4. **两种运行时形态之一**——*gate*（闸门）或 *unwind stamper*（回程盖章器），区别在于如何使用 `next`（下一节）。两种形态可以组合：`requestId` 在 `next()` 之前向 `ctx.state` 播种、在回程给头部盖章；`timeout` 在进入时收窄 `ctx.signal`，之后让整条链与其截止时间赛跑。

## 两种形态

### 闸门：就地作答，绝不向下执行

闸门在它下方的链之前执行请求侧工作。拒绝是结构性的——写一个响应（或抛出），并且**不调用 `next()`**：处理器及其后的所有中间件都不会执行。两种拒绝风格，树中都有实例：

```ts
// 风格 1 —— 抛出 HttpError；链内错误边界会把它渲染成
// 401 响应，附带默认的 { "error": message } JSON 信封。
throw httpError(401, 'invalid api key');

// 风格 2 —— 就地写出拒绝（s200/auth 的做法，这样可以
// 携带 WWW-Authenticate 挑战），然后不调用 next() 直接返回。
json(ctx, { error: 'Unauthorized' }, {
  status: 401,
  headers: { 'www-authenticate': challenge },
});
```

树中的闸门：`basicAuth` / `bearerAuth`（401）、`jwtAuth`（401）、`rateLimit`（429 + `Retry-After`）、`csrf`（403）、`jsonBody` / `queryParams`（400 JSON 格式错误，422 schema 问题）、`timeout`（503）。

接受则是镜像操作：完成工作（解析、验证、计数），把任何请求作用域的结果存到 `ctx.state`，然后 `return next()`。

### 回程盖章器：观察并给响应盖章

盖章器先调用 `await next()`。当它 resolve 时，`ctx.res` **一定存在**——可能是处理器的响应、404/405 回退，或边界给出的错误响应。给头部盖章、替换响应，或者只是观察它：

```ts
// s200/etag，精简至骨架
export function etag(options: EtagOptions = {}): Middleware {
  const prefix = options.strong === true ? '' : 'W/';
  return async (ctx, next) => {
    await next();
    const res = ctx.res; // 类型上是 Response | undefined —— 契约会填上它
    if (res === undefined || res.body === null) return; // 无可标记
    if (res.headers.has('etag')) return;      // 已被他人标记
    if (res.headers.get('content-length') === null) return; // 流式 —— 跳过
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tag = `${prefix}"${hex(await crypto.subtle.digest('SHA-1', bytes))}"`;
    const headers = new Headers(res.headers);
    headers.set('etag', tag);
    ctx.res = newResponse(ctx, bytes, { status: res.status, headers });
  };
}
```

树中的盖章器：`cors`（在包括错误体在内的每个响应上盖章 allow-origin 头——浏览器要读错误响应，就需要这些头）、`logger`（记录真实状态码，500 也不例外）、`etag`（打标签并应答 304）、`secureHeaders`（安全基线）、`compress`（编码有字节背书的 body）。

### 两种形态共同依赖的契约

- **响应在链内物化。** 路由链和 404/405 回退都包在一个错误边界里；抛出的错误会被映射成响应——`HttpError` 取其状态码和消息，其余一律 500——这一切发生在回程开始*之前*。因此 `await next()` resolve 就意味着 `ctx.res` 已设置，无一例外，500 也是。盖章器能看到并可以覆盖每个响应；抛错的闸门，其错误响应照样会被 `cors` 盖章、被 `logger` 记录。
- **第一次 `next()` 完成前再次调用会被拒绝**——抛 `Error('next() called multiple times')`，忠实于 koa-compose。
- **不调用 `next()` 即短路。** 最外层中间件返回时 `ctx.res` 里是什么，适配器就发送什么。

这是盖章器的承重墙——正是它让 `cors`、`logger` 和 `otel` 能承诺错误响应同样被覆盖。

## `defineMiddleware`：对外发布的包装器

```ts
export function defineMiddleware<M extends (ctx: Ctx, next: Next) => Promise<void> | void>(
  mw: M
): M;
```

运行时是恒等函数，零开销。包装换来的是：

1. **完整类型得以保留。** 对无品牌的 battery 来说，把工厂的返回类型标注为普通 `Middleware` 没问题，但这会抹掉注册器本可收集到的任何幻影品牌。把返回的闭包包进 `defineMiddleware`，今天能保留其完整的推断类型，明天它还是 battery 工具（文档生成、契约检查）的挂载点，且不会破坏调用点。
2. **一个可发现的契约。** 一个可导入的符号，声明"这是一个 battery"——作者围绕这个前门编写，消费者扫描它来识别。

```ts
import { defineMiddleware } from 's200';

/** 把每个响应（包括错误响应）标记为 no-store。 */
export const noStore = defineMiddleware(async (ctx, next) => {
  await next();
  ctx.res?.headers.set('cache-control', 'no-store');
});
```

## 类型品牌：`_in` 与 `_out`

幻影属性——仅存在于类型层的交集，运行时永不出现——是中间件的知识到达 `createClient` 的通道，不占用一比特线上格式。两个通道：

**响应侧，`_out`。** 每个响应辅助函数都返回带品牌的 `Response`；`json` 是承载类型的那个：

```ts
export function json<T = unknown, S extends number = 200>(
  ctx: Ctx,
  data: T,
  init?: ResponseInit & { readonly status?: S }
): JsonResponse<T, S>;

// JsonResponse<T, S> = Response & { readonly _out?: T; readonly _status?: S }
```

**请求侧，`_in`。** 验证输入的闸门用自己证明过的事实给自己打品牌，客户端因此可以*要求*它。来自 `s200/validate` 的 `jsonBody`：

```ts
export function jsonBody<T>(
  parse: (data: unknown) => T,
  options?: ValidateOptions
): Middleware & { readonly _in?: { readonly json: T } };
```

**流转方式。** 路由注册器把每条路由串进由应用自身类型携带的幻影日志——`get` / `post` / … 每条路由追加一个条目：

```ts
App<S, [...R, {
  readonly method: 'GET'; readonly pattern: P;
  readonly in: ChainIn<Ms>;     // 所有闸门 _in 品牌的交集
  readonly out: ResolveOut<O>;  // 处理器的 _out（普通 Response 为 unknown）
  readonly status: ResolveStatus<O>;
}]>
```

`createClient(app)` 把这份日志读回来：响应的 `.json()` resolve 为 `out`——无品牌时是 `unknown`，绝不是 `any`——`.status` 收窄到带品牌的字面量。`json` 品牌为 `init.body` 提供类型**并且使其必填**；`query` 品牌（来自 `queryParams`）收窄 `init.query`。一条链上的多个闸门取交集：`jsonBody` + `queryParams` 让同一条路由同时拥有带类型的 body 和带类型的 query。

### 一个完整的 battery 实例：前后对比

一个完整的闸门 battery，采用内置 battery 的形态：

```ts
/**
 * API-key 闸门：拒绝密钥缺失或未知的请求。
 *
 * @module
 */
import { defineMiddleware, httpError } from 's200';
import type { Ctx, Middleware } from 's200';

export type RequireApiKeyOptions = {
  /** 用于解锁该路由的密钥。 */
  readonly keys: readonly string[];
  /** 密钥所在的头部；默认 `x-api-key`。 */
  readonly header?: string;
  /** 吊销或策略钩子；默认：是否属于 `keys`。 */
  readonly verify?: (key: string, ctx: Ctx) => boolean | Promise<boolean>;
};

export function requireApiKey(options: RequireApiKeyOptions): Middleware {
  const header = options.header ?? 'x-api-key';
  const verify = options.verify ?? ((key: string) => options.keys.includes(key));
  return defineMiddleware(async (ctx, next) => {
    const key = ctx.req.headers.get(header);
    if (key === null || !(await verify(key, ctx))) {
      // 由链内错误边界渲染 —— 回程依然看得到
      // 这个 401：CORS 给它盖章，logger 记录它。
      throw httpError(401, 'invalid api key');
    }
    return next();
  });
}
```

**之前**——没有闸门，响应无品牌。客户端能用，但证明不了任何东西：

```ts
import { createApp, get } from 's200';
import { createClient } from 's200/client';

const app = get(createApp(), '/me', (ctx) =>
  new Response(JSON.stringify({ user: 'ada', scopes: ['read'] }), {
    headers: { 'content-type': 'application/json' },
  })
);

const me = await (await createClient(app).get('/me')).json();
//    ^? unknown —— body 是真实的，其形状未被证明
```

**之后**——闸门进链，`json` 负责响应：

```ts
import { createApp, get, json } from 's200';
import { createClient } from 's200/client';

const app = get(
  createApp(),
  '/me',
  requireApiKey({ keys: [SECRET] }),
  (ctx) => json(ctx, { user: 'ada', scopes: ['read'] })
);

const me = await (await createClient(app).get('/me')).json();
//    ^? { user: string; scopes: string[] }
```

再看请求侧——同一份路由日志规定了调用方必须发送什么：

```ts
import { createApp, httpError, json, post } from 's200';
import { jsonBody } from 's200/validate';
import { createClient } from 's200/client';

const app = post(
  createApp(),
  '/users',
  jsonBody((data): { name: string } => {
    if (typeof data !== 'object' || data === null || !('name' in data)) {
      throw httpError(422, 'expected { name: string }');
    }
    return data as { name: string };
  }),
  (ctx) => json(ctx, { ok: true }, { status: 201 })
);

createClient(app).post('/users', { body: { name: 'ada' } });
//                                             ^ 有类型 —— 而且必填：
// 省略 init.body，这个调用将无法通过编译
```

### 为你自己的闸门打品牌

如果你的闸门证明了关于请求的某些事实，就在工厂的返回类型上声明品牌。`_in` 幻影是可选的，裸中间件在结构上即可满足——`jsonBody` 和 `queryParams` 正是这样声明的：

```ts
import { httpError, readJson } from 's200';
import type { Ctx, Middleware } from 's200';

export function signedBody<T>(
  parse: (data: unknown) => T,
  verify: (data: unknown, signature: string | null, ctx: Ctx) => boolean
): Middleware & { readonly _in?: { readonly json: T } } {
  return async (ctx, next) => {
    const data = await readJson(ctx);
    const signature = ctx.req.headers.get('x-signature');
    if (!verify(data, signature, ctx)) {
      throw httpError(401, 'bad signature');
    }
    ctx.state.payload = parse(data);
    return next();
  };
}
```

有一条边界要知道：`createClient` 只重定义 `in` 中 `json` 和 `query` 成员的类型。自定义成员仍会流入路由日志，但客户端会忽略它——当你的闸门验证 JSON body 时，请复用 `json` 成员的形状。

## 结构约定

打开任何一个内置 battery，看到的都是同一副骨架。照着做——消费者是用训练有素的眼睛来读你的 battery 的。

**模块 `@module` JSDoc。** 文件以一个块注释开篇，说明 battery 做什么、范围边界、以及任何顺序敏感性，以 `@module` 结尾。`src/cors.ts` 记录了盖章*为什么*在回程执行；`src/etag.ts` 记录了字节背书的范围（显式 `content-length`）以及哪些会被跳过（流、206 range 响应）。

**选项是 `readonly` 的，默认值只解析一次。** 每个成员都 `readonly`；工厂签名是 `f(options: XOptions = {})`；默认值在构造时解析，因此每请求闭包捕获的是普通值：

```ts
export type EtagOptions = { readonly strong?: boolean };
```

**可注入的接缝。** 任何非确定性的东西（时间、随机性、存储）或承载策略的东西（身份、验证、输出）都是参数：

| 接缝 | 使用者 | 换来什么 |
|---|---|---|
| `store` | `rateLimit`、`cache` | 通过一个小契约（`RateLimitStore.hit`、`CacheStore.get/set/delete`）在实例间共享状态，并提供进程内默认实现 |
| `now` | `rateLimit` | 确定性测试、可重放的时钟 |
| `key` | `rateLimit` | 身份策略——IP、用户 id、API key |
| `sink` / `format` | `logger` | 日志行去哪里、长什么样 |
| `verify` | `basicAuth`、`bearerAuth`、`jwtAuth` | 决策归调用方；battery 只是策略外壳 |
| schema / `parse` | `validate`、`query` | zod、valibot、typebox 由外部注入——绝不导入 |

**状态槽。** 请求作用域的交接数据放在 `ctx.state` 上，位于有文档记录的键下（`validated`、`requestId`、`jwt`、`csrfToken`）。保持在默认 `State` 上，你的 `Middleware` 就能插进任何应用，包括各应用自定义的 `createApp<MyState>()`。

**复用，但不经过 barrel。** `csrf` 需要读 cookie 和解析表单，于是它从 cookies 模块导入 `getCookie` / `setCookie`、从 body 模块导入 `readForm`——直接导入兄弟模块，绝不经过核心 barrel。在仓库内部，经 barrel 导入会把整个核心拖进 battery 的入口，让独立入口形同虚设；直接导入兄弟模块能让构建在各入口间共享同一份核心 chunk。在你自己的包里，同样的纪律上移一层同样成立：从最窄的已发布入口导入（`s200/cookies`，而不是大杂烩式的再导出），因为 tree-shaking 是从 import 语句开始的。

## 测试

通过 `s200/test` 的 `request()` 驱动应用——它在进程内经 `handle()` 分发，语义完整：作用域中间件、回退、错误边界。没有网络、没有服务器，只有真实的 `Response`。

```ts
import { describe, expect, it } from 'vitest';
import { createApp, get, json } from 's200';
import { request } from 's200/test';
import { requireApiKey } from './require-api-key.js';

describe('requireApiKey', () => {
  const app = get(
    createApp(),
    '/me',
    requireApiKey({ keys: ['k'] }),
    (ctx) => json(ctx, { ok: true })
  );

  it('rejects a missing key with 401', async () => {
    const res = await request(app, '/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid api key' });
  });

  it('accepts a listed key', async () => {
    const res = await request(app, '/me', { headers: { 'x-api-key': 'k' } });
    expect(res.status).toBe(200);
  });
});
```

当你的 battery 给路由打品牌时，用 `testClient(app)` 覆盖类型化的往返。可注入的接缝正是测试保持确定性的关键——传入假的 `now`、内存 `store`、预设的 `verify`，就不再需要定时器或网络来制造波动。

## 发布

**命名。** 不带 scope 的 `s200-<thing>`，或 `@you/s200-<thing>`——用户扫描的就是这个前缀。

**peer 而非依赖。** 宿主提供运行时：

```json
{
  "name": "s200-api-key",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.ts", "default": "./dist/index.cjs" }
    }
  },
  "peerDependencies": { "s200": "*" }
}
```

`import` / `require` 双形状与内置 battery 的入口一致；`"sideEffects": false` 保持模块可 tree-shaking。如果你的 battery 需要 zod 或某个签名库，s200 的模式比 peer 依赖更强：做成*参数*（`verify`、一个 schema），什么都不导入——`validate` 正是这样在通过 Standard Schema 对接 zod、valibot、typebox 的同时保持零依赖。

体量预期是这一领域的基本要求：内置 battery 的发布体量大致在 0.5 到 1.6 kB gzipped 之间，每个都有自己的 size-limit 预算把关。以同一量级为目标。

**收编上游。** 赢得通用性的 battery 会毕业进框架。接线是维护者的工作——`package.json` 的 exports 子路径、`vite.config.mts` 的 lib 入口、每个入口一条 size-limit 预算：这三行让"导入一个、只为一个买单"保持诚实。带上你的 battery 及其 request 驱动的测试；仓库负责接线。

## 检查清单

发布前过一遍这个清单：

- 零运行时依赖——`dependencies` 为空；至多只有 peer。
- 数据 + 函数——没有 `class`、没有 `this`、不对自己的类型用 `new`（平台构造器没问题；仓库用 `pnpm check:paradigm` 对自身强制这一点）。
- 独立入口——导入 battery 只拉取它自己；不把核心 barrel 再导出。
- 选项 `readonly`，默认值只在构造时解析一次。
- 非确定性与策略均已注入：`store`、`now`、`key`、`verify`、`sink`、…
- 形态已选定并写进 `@module` 头部——闸门（就地作答，下方链不再执行）或盖章器（`await next()` 之后的 `ctx.res`，恒已设置）。
- 请求作用域数据放在 `ctx.state` 上有文档记录的键下。
- 通过 `json` / `text` / `html` 作答，让 `_out`、`_status` 和 `content-length` 一并搭车；若闸门证明了关于请求的某些事实，给它打上 `_in` 品牌。
- 测试用 `request(app, …)` 驱动；接缝全部伪造，不用定时器或 socket。
- 拒绝契约有明确记载——状态码、body 形状、头部——对闸门而言；对盖章器而言，跳过条件有明确记载。
