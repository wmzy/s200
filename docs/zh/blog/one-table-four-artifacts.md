# 一张路由表，四件产物

在"写完路由"与"跑起整个集群"之间，每个 API 项目都会长出第二份
工作：让 API 的*描述*——文档、客户端、网关配置——与 API 本身保持
同步。多数框架把每一项都当作各自持有事实源的独立集成。s200 的
[data + functions](/zh/comparison) 核心下了不同的赌注：如果应用是
纯数据，那么从它派生的每件产物都可以是纯函数，漂移就不再是一个
流程问题，而是一个不发生的事件。本文让同一张路由表走过四件产物
——一次 JSON 导出、一份 OpenAPI 3.1 文档、一个独立的有类型客户端、
以及 nginx/Kubernetes Gateway API 配置——并展示纯度在每一步买到
什么。

## 表本身

起点不是 DSL 也不是装饰器遍历；而是应用自己的路由表，不执行任何
东西即可导出：

```ts
import { createApp, get, post } from 's200';
import { describeApp, describeRoute } from 's200/meta';
import { createRouteTable, formatRouteTable } from 's200/route-table';

const app = createApp();
get(app, '/users/:id', (ctx) => { /* … */ });
post(app, '/users', (ctx) => { /* … */ });
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: {
    200: { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  },
});

const table = createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 0 }, …] }
```

`createRouteTable` 产出 JSON 兼容的数据——方法、pattern、参数名、
中间件计数（函数本身不可序列化，所以只有计数随行）。
`formatRouteTable` 把它渲染成对齐的 ASCII——`s200 routes` 命令与
dev runner 的启动报告打印的正是它。已经够有用；有意思的消费者
在后面。

## 产物一：OpenAPI 3.1 文档

```ts
import { openapiJson, openapiSpec } from 's200/openapi';

get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
const spec = openapiSpec(app);                               // or hold it as data
```

`openapiSpec` 把路由表与注解一起遍历：每个路由变成一个 path
item，`SerializeSchema` 形状转换成 JSON Schema，出现两次及以上的
schema 去重进 `components.schemas`，`throws` 闸门浮出为错误响应，
`meta.security` 原样落到操作上。没有代码生成、没有执行、没有
schema 库——emitter 是表加其元数据的纯函数。`describeApp` 供给
`info` 块，连文档的标题都来自数据。

因为文档是派生的而非手写的，它无法与路由不一致——注册了但没
注解的 pattern 仍然出现（带参数与一个裸 200），而拼错的 pattern
干脆不在文档里。spec 就是契约；接得上它的工具链见
[OpenAPI 与工具链](/zh/api/openapi)（`s200/swagger` 的 Scalar
文档 UI、OpenAPI 工具链为任何语言生成的类型化客户端）。

## 产物二：有类型客户端，以源码形式

同一次遍历也可以发出 TypeScript 而不是 JSON：

```ts
import { generateClient } from 's200/codegen';
import { writeFile } from 'node:fs/promises';

await writeFile(
  'src/api/client.ts',
  generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' })
);
```

`s200/codegen` 的 `generateClient` 返回一个自足客户端模块的源码：
参数类型来自每个 pattern（`/users/:id` → `args: { id: string }`）、
`init.query` 来自查询注解、`init.body` 来自请求体注解（路由读体，
调用方就必须发送体）、而**按状态判别的响应联合**来自 `meta.responses`
与 `throws` 闸门的合并——收窄 `res.status` 就收窄 `res.json()`。
产出的文件**零 s200 导入**：路径填充、查询串与 JSON 体逻辑全部
内联发出，所以它在任何 web fetch 可运行的地方都能跑，`node_modules`
里不需要 s200——把文件交给另一个团队或另一个仓库都行。

如实的契约随之而行：handler 的 body 品牌是运行时表看不到的编译期
幻影，所以 `meta` 与 `throws` 都未声明的一切类型为 `unknown`。
而且输出是确定性的——注册顺序、无时间戳——所以生成的客户端像
手写源码一样 diff 与提交。这个性质不是偶然；它正是让 codegen
在 CI 里安全运行的东西，而它来自与这里一切相同的源头：对有序
数据的纯函数。

## 产物三：网关配置

最后一件产物回答的是另一个问题——不是"API 长什么样"，而是
"流量如何到达它"。`s200/shard` 的 `shardSpecs(app, groups)` 把
分片组声明对照实际路由表解析成纯 `ShardSpec` 数据；
`s200/gateway` 把这份数据编译成集群实际运行的配置表面：

```ts
import { policy, shardSpecs } from 's200/shard';
import { nginxConf, gatewayRoutes, albRules } from 's200/gateway';

policy(app, 'GET', '/admin/:path*', { timeoutMs: 30_000, streaming: true });
const specs = shardSpecs(app, [
  { id: 'api', prefix: '/api', policy: { timeoutMs: 5_000 } },
  { id: 'admin', prefix: '/admin', entry: './shards/admin.ts' },
  { id: 'main', prefix: '/' },
]);

const nginx = nginxConf(specs, { socketDir: '/run/s200' });   // upstreams + location ^~ blocks
const k8s = gatewayRoutes(specs, { hostname: 'api.example' }); // one Gateway API HTTPRoute, YAML
const alb = albRules(specs, { targetGroupArns: { /* shard id → ARN, every shard needs one */ } });
```

三个部署目标、一个路由事实：nginx 视图发出 `upstream` 块加
`location ^~ <prefix>` server 块；Gateway API 视图发出 Kubernetes
`HTTPRoute` 清单；AWS 视图以 JSON 发出 ALB 监听器规则。前缀在
每个视图里都按字面渲染——nginx `^~`、Gateway API `PathPrefix`、
ALB `path-pattern`——而正则 location 永不发出，因为分片前缀是
纯路径数据。规则按最长前缀优先排序（Gateway API 自上而下求值、
ALB 按升序优先级），没有前导 `/` 的前缀在生成期抛错，而不是
apply 时。

每个生成器都是纯字符串函数——同样的 specs 进、逐字节同样的
字符串出、零 I/O——所以输出可做 golden 测试，可安全交给配置管理
或在 CI 里 diff。加一条路由、挪一个前缀、改一个策略：重新生成的
配置就是可评审的 diff。`matchShard(specs, pathname)`——网关配置
所编码的最长前缀分发——正是 dev 分发器与任何自定义路由器共享的
接缝，所以"nginx 会做什么"与"分发器做什么"也不可能分叉。完整
表面见[分片参考](/zh/api/sharding)。

## 纯度买到什么

四件产物有一个共同的形状：每一个都是纯数据的确定性函数——
不执行、无副作用、产出它们不需要框架运行时。这一条性质为上面
的一切付账：

- **可 CI diff。**确定性输出意味着生成产物像源码一样可评审。
  变更过的客户端或网关配置是一个 diff，不是一次信仰之跃。
- **构造上无漂移。**spec、客户端与网关配置读同一张表。没有第
  二份描述会忘记更新，因为没有第二份描述。
- **可移植。**OpenAPI 文档对接整个 3.1 工具链（任何语言的类型化
  客户端、Scalar、生成器）；发出的客户端模块除了 fetch 什么都
  不需要；网关配置对接你已在运行的基础设施。
- **可测试。**纯函数可做 golden 测试——把精确字节钉进快照，
  路由、注解或分片组的任何变更都表现为一个显式、可评审的增量。

这一切都不需要插件系统、构建钩子或反射 API——只需要保持"应用
是数据、其余皆派生"的纪律。[包表面](/zh/guides/package-surface)
列出全部入口；OpenAPI 侧的遍历见
[OpenAPI 与工具链](/zh/api/openapi)，分片与网关侧见
[分片](/zh/api/sharding)。
