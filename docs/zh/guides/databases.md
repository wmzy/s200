# 数据库

s200 没有数据库层，也不想要——数据库是你的 handler 闭包引用或从 `ctx.state` 读取的一个值，而真正关心它的部件（排空、就绪、取消）已经是电池。本指南是接线模式，不是 ORM 集成；可运行的先例是 [`examples/db-crud`](https://github.com/wmzy/s200/tree/main/examples/db-crud)（经 `node:sqlite` 的 SQLite，零 npm 依赖）与 Redis 配方（见下）。

## 连接池是 state，注入一次

在模块作用域创建连接池，作为类型化 state 注入，让 handler 读 `ctx.state.db` 而不是导入全局。`withState` 给槽位打品牌 —— 下游中间件与 handler 类型化地看到该键，无全局合并、无需 `declare module`：

```ts
import { createApp, get, withState } from 's200';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const withDb = withState<{ db: Pool }>(async (ctx, next) => {
  ctx.state.db = pool;                 // 一次写入，在下方任何东西运行之前
  await next();
});

const app = createApp();
use(app, withDb);

get(app, '/users/:id', async (ctx) => {
  const { rows } = await ctx.state.db.query('select id, name from users where id = $1', [ctx.params.id]);
  return json(ctx, rows[0] ?? null);
});
```

换成每应用形状，则用 `createApp<{ db: Pool }>()` 类型化同一槽位、省去注入器。两种方式下连接池都是每进程一次构造 —— 绝不每请求 —— 而应用仍是普通数据：测试里调用同一工厂、注入接了一次性数据库的第二个应用即可。

## 排空时关连接

`lifecycle` 掌管停机顺序：先翻就绪闸（负载均衡器停止派流），再停止监听，然后给在途请求预算 —— 最后才跑你的清理 hook。关连接池属于 `onShutdown`，在最后一条查询结束之后：

```ts
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate, readiness } from 's200/health';

const gate = createGate();
get(app, '/health/ready', readiness({ db: () => pool.query('select 1'), drain: gate.check }));

const server = await serve(app, { port: 3000 });
const done = lifecycle(server, {
  readiness: gate,
  onShutdown: async () => { await pool.end(); },
});
await done.stopped;
```

其余时间里，同一个 `pool.query('select 1')` 检查应答就绪探针：任何 throw 或 reject 的检查都会把响应变成点名原因的 `503`，且每个检查与自己的预算赛跑（默认 1000 ms）—— 卡死的数据库让探针失败，而不是挂起探针。

## 把请求的 signal 交给查询

`ctx.signal` 在客户端断开时触发。接受 `AbortSignal` 的驱动（node-postgres 在查询配置里收 `signal`）就该拿到它 —— 断开的调用者不再为没人读的查询付费：

```ts
get(app, '/users/:id', async (ctx) => {
  const { rows } = await ctx.state.db.query({
    text: 'select id, name, email from users where id = $1',
    values: [ctx.params.id],
    signal: ctx.signal,               // 随连接一起中止
  });
  if (rows.length === 0) throw httpError(404, `No user ${ctx.params.id}`);
  return json(ctx, rows[0]);
});
```

`timeout` 电池在另一侧以同样方式组合：它按截止时间收窄 `ctx.signal`，链输掉赛跑时应答 503。

## 事务是帮助函数，不是框架特性

没有什么要集成：事务就是一个取出客户端、跑 BEGIN/COMMIT/ROLLBACK、把客户端递给你的回调的函数。把它的失败映射为 HTTP 事实放在边缘处：

```ts
export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

post(app, '/users', jsonBody(parseUser), async (ctx) => {
  try {
    return json(ctx, await withTransaction(ctx.state.db, async (tx) => {
      const { rows } = await tx.query('insert into users (name, email) values ($1, $2) returning *',
        [ctx.state.validated.name, ctx.state.validated.email]);
      await tx.query('insert into audit_log (what) values ($1)', ['user_created']);
      return rows[0];
    }), { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) throw httpError(409, 'email already registered');
    throw error;                      // 错误边界映射其余的
  }
});
```

`examples/db-crud` 跑的正是这个形状：缺行是 `httpError` 404，UNIQUE 冲突是 409 Conflict，而 handler 是数据库事实变成 HTTP 事实的唯一场所。

## 分布式存储

当状态在 Redis 后面（限流计数器、跨舰队共享的会话）时，电池的 `store` 接缝接受一个 vendored 适配器 —— 见[分布式存储](/zh/guides/distributed-stores)与 [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) 里的配方：输入四个结构化类型的 Redis 命令，输出对应电池注入的恰是 `RateLimitStore`/`SessionStore` 接口。
