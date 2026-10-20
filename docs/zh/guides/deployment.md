# 部署

## 你部署的是什么

s200 首先是一个函数，其次才是一个服务器。整个运行时契约就是 `handle(app, request)` —— 进来一个 Web Standard `Request`，出去一个 `Response`：

```ts
import { createApp, handle } from 's200';

const app = createApp();
const response = await handle(app, request);
```

每个适配器都是这个调用之上的一层薄包装 —— 从平台事件构造 `Request`，调用 `handle`，把 `Response` 写回去（见[适配器](/guides/adapters)）。任何能构造 `Request` 的运行时就已经是部署目标；本指南其余部分是生产接线，不是移植。

## 生产环境下的 Node {#node-in-production}

生产入口 = `serve` + `lifecycle`。`serve(app, options)` 绑定端口（`port` 默认 0 —— 临时端口，所以必须显式设置；`host` 省略时绑定所有网卡）。`lifecycle(server, options)` 把 SIGTERM/SIGINT 变成按负载均衡安全的顺序执行的优雅排水：先关闭就绪闸门（探针回答 503，流量停止到达），然后服务器停止接受连接，在途请求在预算内完成，逾期者（或第二个信号到来时）被硬杀，最后才运行 `onShutdown`：

```js
// server.mjs — the whole production entry
import { createApp, get } from 's200';
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate, health, readiness } from 's200/health';

const gate = createGate();
const app = createApp();
get(app, '/live', health());
get(app, '/ready', readiness({
  db: () => db.query('select 1'),  // any () => void | Promise<void>
  drain: gate.check,               // 503 "draining" from the first drain step
}));

const server = await serve(app, {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',  // bind 127.0.0.1 behind a local reverse proxy
});

const drain = lifecycle(server, {
  timeout: 15_000,        // in-flight budget in ms — default 10_000
  readiness: gate,        // closed with "draining" before any socket closes
  onShutdown: () => db.close(),
});
await drain.stopped;      // signals ride the same path as stop(); never rejects
```

`lifecycle` 对适配器暴露的原始服务器做鸭子分派：node 路径持续收割排水中途转入空闲的 keep-alive 连接、到期强制关闭；Bun 路径映射到 `stop(false)`/`stop()`；其余回退到适配器自己的 `close()`。选项：`signals`（默认 `['SIGTERM', 'SIGINT']`，传 `[]` 表示信号自己处理）、`timeout`（排水预算，默认 10 000 毫秒）、`readiness`（闸门 —— 结构化的，任何带 `close(reason?)` 的对象都行）、`onShutdown`（你的清理钩子）。

### Dockerfile

多阶段构建让最终镜像只剩 `node_modules` + 构建产物 —— 最终层里没有工具链：

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build                          # your build — emits server.mjs and friends

FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
```

用 `docker run --init`（或 Compose 的 `init: true`）运行，让信号以 PID 1 的正确方式到达 node。

### systemd

`KillSignal=SIGTERM` 与 `lifecycle` 默认监听的信号一致；`TimeoutStopSec` 必须超过排水预算 —— 否则 systemd 会在排水中途 SIGKILL 进程：

```ini
[Unit]
Description=s200 app
After=network-online.target
Wants=network-online.target

[Service]
User=app
WorkingDirectory=/srv/app
ExecStart=/usr/bin/node server.mjs
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 健康探针

`s200/health` 提供编排器想要的双信号拆分。`health()` 是存活探针 —— 能应答的进程就是活着的，零依赖，所以一个坏数据库永远不会导致容器被重启：

```ts
import { get } from 's200';
import { health, readiness } from 's200/health';

get(app, '/live', health());   // 200 {"status":"ok"}
get(app, '/ready', readiness({
  db: () => db.query('select 1'),  // each check: returns/resolves = healthy
  drain: gate.check,               // the gate trips while draining
}, { timeout: 500 }));             // per-check budget in ms — default 1000
```

`readiness(checks, options)` 在同一个按检查预算（默认 1000 毫秒）下并发运行所有检查：全部健康 → 200 `{"status":"ok","checks":{"db":"ok",...}}`，任一失败 → 503 并带上失败检查的原因。`drain: gate.check` 这一项正是把探针与[优雅排水](#node-in-production)绑在一起的东西：把同一个 `createGate()` 闸门接进 `lifecycle` 的 `readiness` 选项，排水开始的那一刻 `/ready` 就开始回答 503 —— 在任何连接关闭之前，负载均衡器或 kubelet 会先停止把流量路由到这个 Pod。

Kubernetes 一行式：

```yaml
livenessProbe:
  httpGet: { path: /live, port: 3000 }
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
```

## Serverless / 边缘

Cloudflare Workers —— `s200/cloudflare` 构造模块 worker 的默认导出，客户端断开信号已接线：

```ts
import { createHandler } from 's200/cloudflare';

export default createHandler(app);
```

想要 `fetch` 导出的 Vercel/Netlify 风格运行时，就是把契约手写出来：

```ts
import { createApp, handle } from 's200';

const app = createApp();
export default { fetch: (request) => handle(app, request) };
```

AWS Lambda 没有内置适配器 —— 这是诚实的缺口。桥接只需十几行：把 API Gateway 的 HTTP 事件包装成 `Request` 交给 `handle`；注意 base64 编码的请求体：

```ts
export async function handler(event) {
  const request = new Request(
    `https://${event.requestContext.domainName}${event.rawPath}?${event.rawQueryString}`,
    {
      method: event.requestContext.http.method,
      headers: event.headers,
      body: event.isBase64Encoded
        ? atob(event.body)          // binary payloads arrive base64-encoded
        : event.body,
    },
  );
  const response = await handle(app, request);
  return { statusCode: response.status, body: await response.text() };
}
```

## Bun

`s200/bun` 通过 `Bun.serve` 服务 —— 同样的 `serve(app, { port })` 形状，见[适配器](/guides/adapters)。`lifecycle` 对其结果原样可用（`stop(false)` 优雅、`stop()` 强制）。要单文件二进制，编译入口：

```sh
bun build --compile server.ts --outfile app
./app
```

## 生产检查清单

- **在代理后面？** 在任何会推理源站的东西之前注册来自 `s200/trust-proxy` 的 `trustProxy({ hops: 1 })` —— 它用 `X-Forwarded-Proto`/`X-Forwarded-Host` 重写 `ctx.url`，并把客户端 IP 放到 `ctx.state.proxy.clientIp`。`hops` 是你信任的代理数量（默认 1）。
- **在边缘限流** —— `rateLimit`（`s200/rate-limit`，滑动窗口、可注入存储）挡在匿名流量能到达的路由之前。
- **全链路关联** —— `s200/request-id` 的 `requestId` 盖一个唯一头，logger 和你的日志都能按它关联。
- **压缩与缓存** —— `compress`（`s200/compress`，`Content-Encoding` 协商）和 `etag`（`s200/etag`，字节背书请求体上的条件 304）。
- **给慢处理器设上限** —— `s200/timeout` 的 `timeout(ms)` 回答 504，而不是钉死一条连接。
- **集中设置面向浏览器的头** —— `s200/secure-headers` 的 `secureHeaders`（HSTS 属于 TLS 边缘）和 `s200/cors` 的 `cors`（跨域浏览器 API）。
- **接好排水** —— `serve` + `lifecycle` + `/ready` 里的 `createGate()` 闸门（见上文），并让编排器的停止超时与 `lifecycle` 的 `timeout` 对齐。
- **有意识地绑定** —— 本地反向代理终结 TLS 时 `HOST=127.0.0.1`；把 `PORT` 暴露成平台设置的唯一旋钮。
