# 适配器

## 服务

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 0 });  // 0 = ephemeral
// server: { server, url, port, close(): Promise<void> }

import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });
```

两个适配器暴露相同的 `serve(app, options)` 面；核心的 `handle(app, request)` 是任何 fetch 形态运行时的全部集成契约 —— `s200/deno`（`Deno.serve` 之上的 `serve(app)`）和 `s200/cloudflare`（`createHandler(app)` 作为模块 worker 的默认导出）是那两个运行时的一行适配器。

## 轻量模式

`s200/node` 有可选的**轻量模式（light mode）** —— `serve(app, { light: true })` 把平台每请求的 `Request`/`Response` 构造器换成轻量鸭子类型实现（不打任何全局补丁，Web Standard 契约保持默认）。在轻量路径上 `ctx.req.headers`/`ctx.res.headers` 是 `LightHeaders` —— 一个鸭子 `Headers`，具有完整的结构 API（`get`/`set`/`has`/`append`/`delete`/`getSetCookie`/迭代）、大小写不敏感、插入有序，处处是合法的 `HeadersInit`（平台构造器从其 pair 迭代器填充）；`instanceof Headers` 在那里就是 false。见 `../benchmarks.md`：轻量模式带来约 28–35% 的整请求吞吐提升（依机器而定），落在真实 Web Standard 类与打补丁类之间。电池也走轻量路径 —— `compress`/`etag` 基于轻量响应的同步字节工作（流式请求体通过 `CompressionStream` 不变地管道传输），`stream`/`streamSSE` 骑在轻量响应的流式请求体上，`serveStatic` 服务字节体、流式文件和字节范围，请求体读取器（`readJson`/`readText`/`readForm`/`readStream`）读取轻量请求的流 —— 客户端断开在这里像默认路径一样中止 `ctx.signal`。

## TLS

`s200/node` 还服务 TLS —— HTTPS，或 TLS 之上的 HTTP/2 —— 通过同一条分发管道。HTTPS 与 `upgrade` 结合提供 WSS（WebSocket 处理器在解密连接上运行）；只有 `http2: true` 禁止 `upgrade`，因为 HTTP/2 没有 upgrade 事件：

```ts
await serve(app, {
  port: 443,
  https: { key: await readFile('key.pem'), cert: await readFile('cert.pem') },      // node:https
});
await serve(app, {
  port: 443,
  https: { key, cert, http2: true },                                                  // node:http2
});
await serve(app, {
  port: 443,
  https: { key, cert },                                                               // WSS
  upgrade: createUpgradeHandler(app),
});
```
