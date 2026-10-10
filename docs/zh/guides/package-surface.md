# 包导出清单

## 核心 barrel

一切都是核心 barrel（`s200`）的命名导出 —— tree-shaking 从 import 语句开始（`defineMiddleware`，第三方电池编写钩子，也在那里）。

## 包入口

以下每个都是独立的包入口 —— 引入一个只拉入它本身。每个名字都链接到 [API 参考](/zh/api/core)中的对应章节：

- **核心 barrel**: [`s200`](/zh/api/core) —— `createApp`、路由原语；barrel 的[响应助手](/zh/api/respond#响应助手)、[请求体读取](/zh/api/respond#请求体读取)与 [`serveStatic`](/zh/api/respond#静态文件)
- **适配器**: [`s200/node`](/zh/api/node), [`s200/bun`](/zh/api/bun), [`s200/deno`](/zh/api/edge#deno-s200-deno), [`s200/cloudflare`](/zh/api/edge#cloudflare-workers-s200-cloudflare)
- **安全**: [`s200/cors`](/zh/api/security#cors-s200-cors), [`s200/csrf`](/zh/api/security#csrf-s200-csrf), [`s200/auth`](/zh/api/security#认证-s200-auth), [`s200/jwt`](/zh/api/security#jwt-s200-jwt), [`s200/secure-headers`](/zh/api/security#安全头-s200-secure-headers), [`s200/rate-limit`](/zh/api/security#限流-s200-rate-limit), [`s200/trust-proxy`](/zh/api/security#信任代理-s200-trust-proxy)
- **请求接入**: [`s200/validate`](/zh/api/request#验证-s200-validate), [`s200/query`](/zh/api/request#查询-s200-query), [`s200/accepts`](/zh/api/request#内容协商-s200-accepts), [`s200/multipart`](/zh/api/request#multipart-s200-multipart), [`s200/upload`](/zh/api/request#upload-s200-upload)
- **响应电池**: [`s200/serialize`](/zh/api/response-batteries#序列化-s200-serialize), [`s200/etag`](/zh/api/response-batteries#etag-s200-etag), [`s200/compress`](/zh/api/response-batteries#压缩-s200-compress), [`s200/streaming`](/zh/api/response-batteries#流式-s200-streaming)
- **Cookie 与会话**: [`s200/cookies`](/zh/api/cookies-session#cookie-s200-cookies), [`s200/session`](/zh/api/cookies-session#会话-s200-session)
- **可观测性**: [`s200/logger`](/zh/api/observability#日志-s200-logger), [`s200/request-id`](/zh/api/observability#请求-id-s200-request-id), [`s200/otel`](/zh/api/observability#otel-s200-otel), [`s200/version`](/zh/api/observability#api-版本-s200-version)
- **数据与配置**: [`s200/cache`](/zh/api/data#缓存-s200-cache), [`s200/config`](/zh/api/data#配置-s200-config), [`s200/events`](/zh/api/data#事件-s200-events), [`s200/schedule`](/zh/api/data#调度-s200-schedule)
- **实时**: [`s200/websocket`](/zh/api/websocket#注册-s200-websocket), [`s200/websocket/node`](/zh/api/websocket#node-s200-websocket-node), [`s200/websocket/bun`](/zh/api/websocket#bun-s200-websocket-bun)
- **OpenAPI 与工具**: [`s200/route-table`](/zh/api/openapi#路由表-s200-route-table), [`s200/meta`](/zh/api/openapi#元数据-s200-meta), [`s200/openapi`](/zh/api/openapi#openapi-s200-openapi), [`s200/swagger`](/zh/api/openapi#swagger-ui-s200-swagger), [`s200/codegen`](/zh/api/openapi#代码生成-s200-codegen), [`s200/client`](/zh/api/openapi#客户端-s200-client), [`s200/test`](/zh/api/openapi#测试-s200-test)
- **生命周期**: [`s200/lifecycle`](/zh/api/lifecycle#生命周期-s200-lifecycle), [`s200/health`](/zh/api/lifecycle#健康-s200-health), [`s200/timeout`](/zh/api/lifecycle#超时-s200-timeout), [`s200/dev`](/zh/api/lifecycle#热重载-s200-dev)
- **分片与执行**: [`s200/shard`](/zh/api/sharding#分片-s200-shard), [`s200/gateway`](/zh/api/sharding#网关-s200-gateway), [`s200/shard-dev`](/zh/api/sharding#开发调度器-s200-shard-dev), [`s200/executor`](/zh/api/sharding#执行器-s200-executor), [`s200/unit-metrics`](/zh/api/sharding#单元指标-s200-unit-metrics)

## 依赖

除 `s200/events` 外，核心与所有电池都是零依赖；`s200/events` 添加 [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) 作为其唯一依赖。

## JSR

仓库维护一份 `jsr.json` —— `pnpm publish:jsr` 将构建产物作为 `@wmzy/s200` 发布到 [JSR](https://jsr.io)。

每个入口的导出、签名与选项见 [API 参考](/zh/api/core)。
