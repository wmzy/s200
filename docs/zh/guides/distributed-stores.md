# 分布式存储

s200 的 `rateLimit` 和 `createSession` 这两个 battery 自带进程内默认实现：一个按键记录的时间戳双端队列、一个惰性过期淘汰的 map。这些默认实现是*进程*级的——在负载均衡器后面跑三个实例，每个实例各自执行自己的限额、各自记住自己的会话，而一个在实例间跳转的客户端，每次跳转都从零开始。修复办法不是往框架里加更多代码，而是利用两个 battery 都已具备的接缝：注入一个全机群共享的 store。

本指南用官方配方 [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) 把这条接缝接到 Redis 上——该文件是仓库级 TypeScript，刻意**不**作为包导出（s200 按契约零依赖）。把这一个文件 vendor 进你的项目，自带 Redis 客户端，然后注入即可。

```ts
import { Redis } from 'ioredis';
import { createRedisRateLimitStore, createRedisSessionStore } from './redis-stores'; // 已 vendor

const redis = new Redis(process.env.REDIS_URL!);
const rl = createRedisRateLimitStore(redis);
const sessions = createRedisSessionStore(redis, 'myapp:sess:');
```

## 两条接缝

两个契约都小到一口气就能读完：

```ts
// rateLimit：只有一个方法，且必须按键原子执行
type RateLimitStore = {
  hit(key: string, now: number, limit: number, windowMs: number):
    RateLimitHit | Promise<RateLimitHit>; // { count, retryAt }
};

// createSession：三个方法；set 接收 cookie 的 TTL
type SessionStore = {
  get(id: string): SessionData | undefined | Promise<SessionData | undefined>;
  set(id: string, data: SessionData, ttlSeconds: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
};
```

任何在共享状态之上满足这些契约的东西都行——这里用 Redis，也可以是一张 SQL 表、一个 KV 命名空间。状态放在哪里由 store 决定；battery 自身的行为（429 + `Retry-After` 原样保留、cookie 握手、读取时过期）保持不变。

## `RedisLike`：自带客户端

配方不导入任何 Redis 库；它们把所需的四条命令声明为一个结构化类型：

```ts
type RedisLike = {
  eval(script: string, numKeys: number, ...keysAndArgs: Array<string | number>):
    unknown[] | Promise<unknown[]>;
  get(key: string): string | null | Promise<string | null>;
  setex(key: string, seconds: number, value: string): unknown | Promise<unknown>;
  del(key: string): unknown | Promise<unknown>;
};
```

**ioredis** 原样满足它——直接把客户端传进来。

**node-redis**（v4+）有两处写法不同：`eval` 接收的是选项对象（`{ keys, arguments }`）而非位置参数形式，SETEX 则是驼峰拼写。四行代码即可弥合：

```ts
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const redis = {
  eval: (script: string, numKeys: number, ...rest: Array<string | number>) =>
    client.eval(script, {
      keys: rest.slice(0, numKeys).map(String),
      arguments: rest.slice(numKeys).map(String),
    }) as Promise<unknown[]>,
  get: (key: string) => client.get(key),
  setex: (key: string, seconds: number, value: string) =>
    client.setEx(key, seconds, value),
  del: (key: string) => client.del(key),
};
```

## 限流：一条 EVAL，构造即原子

```ts
import { createApp, get, use } from 's200';
import { rateLimit } from 's200/rate-limit';
import { createRedisRateLimitStore } from './redis-stores'; // 已 vendor

const store = createRedisRateLimitStore(redis); // 键在 's200:rl:' 前缀下
const app = createApp();
use(app, rateLimit({ windowMs: 60_000, limit: 100, store }));
get(app, '/', (ctx) => new Response('ok'));
```

store 的全部记账逻辑就是一段 Lua 脚本，作为一条 `EVAL` 执行：

```lua
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
```

**为什么用一段脚本而不是两条命令。** 朴素的移植——`INCR key`，然后当返回值为 `1` 时再 `EXPIRE key windowMs`——存在经典的竞态：两个实例并发自增，都可能看到中间值（或者完全错过 `1`，导致 TTL 未被设置），而在两条命令之间死掉的进程会留下一个永久计数器，把某个 key 永远封死。Redis 串行执行每段脚本，因此自增、TTL 检查和（条件性的）`PEXPIRE` 作为一个整体落位——每个进程的每个实例看到的都是同一个 `count`，且窗口恰好被武装一次，由创建该 key 的那次自增完成。`ttl < 0` 分支还能自我修复：被其他工具写入的、没有 TTL 的杂散 key 会被补上过期时间，而不是无限计数。`rateLimit` 把返回的 `PTTL` 换算成 `retryAt`，battery 再将其渲染为 `Retry-After`——被挡下的调用方被告知的是窗口的真实剩余时间，而不是猜测值。

**窗口语义——清楚你部署的是什么。** 进程内默认实现是*真正的*滑动窗口：每次命中在其落位后恰好 `windowMs` 过期，因此限额在窗口边缘是防突发的。Redis 配方则是*锚定在首次命中的固定窗口*：计数器整体过期。两个后果：

- 在窗口边缘，客户端可以在过期前紧贴边界发出至多 `limit` 个请求，在过期后紧贴边界再发出 `limit` 个——这就是固定窗口的突发；
- 限额在全机群范围内*精确*成立——这正是多实例部署真正需要、而内存默认实现无法提供的性质。

如果在你的限额下边缘突发不可接受，可以按比例缩小 `windowMs`（半限额的 30 秒窗口近似 60 秒滑动预算），或者把脚本升级为有序集合窗口（`ZREMRANGEBYSCORE` + `ZADD` + `ZCARD` + `PEXPIRE`，仍然是一条 EVAL）——store 契约接受任何如实上报 `{ count, retryAt }` 的实现。

**键与前缀。** 键就是 battery 的 `key` 选项产出的值（默认取 `x-forwarded-for` 的第一跳——只有在会覆写它的代理后面才有意义），统一加 `s200:rl:` 前缀。多个应用共享同一个 Redis 时应传入互不相同的前缀：`createRedisRateLimitStore(redis, 'api-a:rl:')`。

## 会话：与 cookie 同生共死的记录

```ts
import { createSession } from 's200/session';
import { createRedisSessionStore } from './redis-stores'; // 已 vendor

const { middleware } = createSession({
  secret: process.env.SESSION_SECRET!,
  store: createRedisSessionStore(redis), // 键在 's200:sess:' 前缀下
});
```

映射关系一共三条命令：

- `set(id, data, ttlSeconds)` → `SETEX s200:sess:<id> <ttlSeconds> <json>` —— battery 传入的 TTL *就是* cookie 的 `maxAge`，因此 Redis 里的记录和浏览器里的 cookie 同时消亡。没有 id 能活得比它的凭证更久；也不需要清扫任务。
- `get(id)` → `GET s200:sess:<id>` 加 `JSON.parse` —— 过期记录已被 Redis 淘汰，而解析失败的记录视为无会话：中间件会新铸一个会话，而不是让请求失败。
- `delete(id)` → `DEL s200:sess:<id>` —— 即 `session.destroy()` 触发的操作。

**滑动过期。** `session.touch()` 在 unwind 阶段续期：中间件以相同的 `maxAge` 重新执行 `set`，新的 `SETEX` 把记录（和 cookie）的死期向后推移——闲置会话自然过期，活跃会话只要保持活跃就一直存活。变更操作（`set`/`delete`/`clear`）以相同方式持久化；只读的请求不留任何写入、也不发 `Set-Cookie`，因此 Redis 不会平白承受那些从不触碰会话的流量的冲击。

**实例自由。** 因为事实的源头是记录而非实例，任何实例都能服务任何请求：会话在部署、重启和负载均衡器的任意调度下幸存，而签名 cookie 握手（`s200.sid` + `s200.sid.sig`）随客户端行走——数据本身做不到这一点。

## KV 变体（Upstash 等）

配方的形态可以移植到任何兼容 Redis 的边缘环境：

- **Upstash Redis** 通过其 REST API 执行 EVAL，而 `@upstash/redis` 的 `numkeys` 由分开的 key/arg 数组推导——只需适配那一行 `eval`：`(script, keys, args) => upstash.eval(script, keys, args)`。它的 `Script` 助手按 SHA 缓存以减少线上传输的字节数；如果你想要它的客户端而不是 battery，官方 `@upstash/ratelimit` 包自带固定窗口、滑动窗口和令牌桶的 Lua 实现——这些接缝可以互换。
- **没有 Lua 的 KV**（普通 KV 命名空间）：做不出原子的"INCR 带 TTL"。要么接受极小的竞态（先 INCR，仅当返回值为 `1` 时才设置过期——两条命令之间的一次失败写入会留下一个永久计数器，需要周期性清理来收割），要么用按窗口分键的方式近似（`rl:<key>:<floor(now/windowMs)>`），其 TTL *本身*就是原子性——无论发生什么，每个窗口的计数器都会按时消亡。对于会话，带 `expirationTtl` 的 KV `put` 与 `set` 一一对应；`expirationTtl` 有 60 秒下限，因此分钟以内的 cookie TTL 需要在读取时检查记录的过期时间。

配方所编码的一般法则：把原子决策压缩到后端允许的最少往返次数内，让 TTL 完成清理，并让每个过期时间都与它所背书的凭证对齐。
