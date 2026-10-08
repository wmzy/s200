# 安全（`s200/cors`、`s200/csrf`、`s200/auth`、`s200/jwt`、`s200/secure-headers`、`s200/rate-limit`、`s200/trust-proxy`）

CORS、CSRF、认证闸门、JWT、基线安全头、滑动窗口限流与反向代理感知。

## CORS（`s200/cors`）

应用级或逐路由。预检以 `204` 就地应答（handler 永不运行）；实际响应在 unwind 时盖上 allow-origin 头 —— 回退的 404/405/500 响应也包含在内，因为它们在链内物化。

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
```

`CorsOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `origin` | `'*'` | 固定源、白名单或逐请求解析器 `(ctx) => string \| undefined` |
| `methods` | 回显请求 | 预检 `Access-Control-Allow-Methods` |
| `headers` | 回显请求 | 预检 `Access-Control-Allow-Headers` |
| `exposeHeaders` | — | `Access-Control-Expose-Headers`，让页面脚本读取自定义响应头 |
| `credentials` | `false` | `Access-Control-Allow-Credentials` |
| `maxAge` | — | 预检缓存时长 |

默认 `'*'` 发出字面通配符并跳过 `Vary: Origin`；白名单与解析器回显请求源并设置 `Vary: Origin`。浏览器拒绝带凭据的通配符源（fail-closed）—— 把 `credentials` 与显式源配对。

## CSRF（`s200/csrf`）

无会话同步令牌：HMAC 签名（`nonce` + 过期期），只有你的密钥能铸造，经 cookie 传递，在非安全请求上对**头部/表单字段**与请求 `Origin` 双重校验（堵死两个经典双重提交漏洞）：

```ts
const csrf = createCsrf({ secret: CSRF_SECRET });   // 密钥别进版本控制
use(app, csrf.middleware);
get(app, '/form', (ctx) => html(ctx, `<input type="hidden" name="_csrf" value="${await csrf.token(ctx)}">`));
```

`CsrfOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `secret` | （必填） | HMAC 密钥（`string` 或字节） |
| `cookie` | `'csrf_token'` | 承载令牌的 cookie 名 |
| `header` | `'x-csrf-token'` | 提交令牌的头名 |
| `form` | `'_csrf'` | 提交令牌的表单字段名 |
| `ttl` | 7 天 | 令牌寿命（秒） |
| `path` / `sameSite` / `httpOnly` / `secure` | `'/'` / `'lax'` / `true` / — | cookie 属性；保持 `httpOnly` 并经端点或服务端渲染表单传递令牌 |

`Csrf`：`{ middleware, token }` —— `middleware` 在安全请求上保证 `ctx.state.csrfToken` 有有效令牌（需要时刷新 cookie），在非安全请求上校验 `Origin` + 提交的令牌（就地 403）；`token(ctx)` 返回请求的有效 cookie 令牌（或新铸的）用于嵌入表单。

## 认证（`s200/auth`）

`basicAuth` / `bearerAuth` 闸门：`verify` 函数裁决；失败以 `401` + `WWW-Authenticate` 就地应答，其下链条永不运行。`verify` 内的凭据比较是你的责任 —— 密钥请用常量时间比较。

```ts
use(app, basicAuth(async (user, pass) => user === 'admin' && (await check(pass))));
use(app, bearerAuth(async (token) => token === API_TOKEN));
```

| 函数 | 签名 |
| --- | --- |
| `basicAuth(verify, options?)` | `verify(username, password, ctx) => boolean \| Promise<boolean>` |
| `bearerAuth(verify, options?)` | `verify(token, ctx) => boolean \| Promise<boolean>` |

`BasicAuthOptions` / `BearerAuthOptions`：`{ realm?: string }` —— 401 挑战的 realm，默认 `'s200'`。

## JWT（`s200/jwt`）

HS256/384/512、RS256/384/512、PS256/384/512 与 ES256/384/512，基于 WebCrypto，零依赖。

| 函数 | 含义 |
| --- | --- |
| `signJwt(payload, key, options?)` | 紧凑 JWT `header.payload.signature`；options 中的声明覆盖同名 payload 键 |
| `verifyJwt<T>(token, key, options?)` | 校验结构、算法、签名、`exp`/`nbf`、要求的 `aud`/`iss` → `T & RegisteredClaims`；任何失败抛 `JwtError` |
| `jwtAuth(options)` | 闸门中间件：提取令牌（头 `Authorization: Bearer …` 或 cookie）、校验、把载荷存入 `ctx.state.jwt`；缺失/无效 → `401` |
| `createJwksResolver(url, options?)` | 基于 JWKS 端点构建 `KeyResolver` —— 拉取、缓存（`ttlMs`，默认 5 分钟）、按 `kid` 选取；按 URL 模块级缓存 |
| `isJwtError(error)` | `JwtError` 谓词 |

| 类型 | 含义 |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| … \| 'ES512'` |
| `JwtKey` | `string \| Uint8Array \| CryptoKey \| JsonWebKey` |
| `JwtSignOptions` | `{ alg?, expiresIn?, notBefore?, issuedAt? \| false, audience?, issuer?, subject?, jwtId? }` —— 用 `CryptoKey`/JWK 签名时 `alg` 必填 |
| `JwtVerifyOptions` | `{ algorithms?, audience?, issuer?, clockTolerance? }` —— `alg:none` 无条件拒绝 |
| `RegisteredClaims` | `{ iat?, exp?, nbf?, iss?, sub?, aud?, jti? }` |
| `JwtHeader` | `{ alg, kid? }` —— `KeyResolver` 所见 |
| `KeyResolver` | `(header: JwtHeader) => JwtKey \| Promise<JwtKey>` |
| `JwksOptions` | `{ ttlMs?, fetchFn? }` |

密钥族必须与头部算法匹配（HS 需要密钥，RS/PS 需要 RSA 密钥，ES 需要 EC 密钥 —— 混淆攻击在结构上被封死）。`jwtAuth` 的密钥来源：`secret`、`key`、`keyResolver`、`jwks`（`string` 或 `{ url, ttlMs? }`），或自定义 `verify`（另一个库、奇异令牌 —— 返回值落到 `ctx.state.jwt`）。

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));
// 密钥轮换：use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
```

## 安全头（`s200/secure-headers`）

安全默认基线，在 unwind 时盖上（回退响应也包含）；响应已有的头绝不覆盖，`false` 则移除某项：

```ts
use(app, secureHeaders());  // nosniff、DENY 框架嵌入、strict-origin-when-cross-origin
```

`SecureHeadersOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `xContentTypeOptions` | `'nosniff'` | `false` 移除 |
| `xFrameOptions` | `'DENY'` | 需要嵌入的应用用 `SAMEORIGIN`（或 CSP frame-ancestors 策略） |
| `referrerPolicy` | `'strict-origin-when-cross-origin'` | |
| `strictTransportSecurity` | 关 | 显式开启 —— 在 TLS 终止代理之后， stray HSTS 头可能把域名钉死在坏配置上 |

## 限流（`s200/rate-limit`）

按客户端密钥的真滑动窗口闸门：每次命中在落地 `windowMs` 后过期（无固定边界，因此窗口边缘无法突发）。超限请求就地以 `429` + `Retry-After` 应答；其下链条永不运行。

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

`RateLimitOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `windowMs` | `60_000` | 窗口长度（毫秒） |
| `limit` | `60` | 每窗口每密钥请求数 |
| `key` | 首个 `x-forwarded-for` 跳 | 身份选择器 `(ctx) => string` —— 传你自己的（以及测试用的 `now` 时钟） |
| `now` | `Date.now` | 时钟覆盖 |
| `store` | 每密钥进程内双端队列 | 跨实例共享计数：`hit(key, now, limit, windowMs) => RateLimitHit \| Promise<RateLimitHit>` —— 必须按键原子（Redis INCR + PEXPIRE 形状） |

`RateLimitHit`：`{ count: number; retryAt: number }` —— 存活计数与最早可重试时间。默认存储是每实例的；共享限流需要注入 `store`。

## 信任代理（`s200/trust-proxy`）

从 `X-Forwarded-Proto`/`X-Forwarded-Host` 修正 `ctx.url` 的协议/主机，并在 `ctx.state.proxy` 记录客户端地址，`X-Forwarded-For` 按跳计数（从右向左选取，跳过非可信跳）。把它注册在 `s200/csrf`、`s200/secure-headers` 以及一切构造绝对 URL 的功能**之前**：

```ts
use(app, trustProxy({ hops: 1 }));   // 位于一个可信反向代理之后
```

`TrustProxyOptions`：`{ hops?（默认 1）, protoHeader?, hostHeader?, forHeader? }`。`ctx.state.proxy` 条目（`TrustProxyInfo`）：`{ proto?, host?, clientIp? }` —— 用 `TrustProxyState` 增强 `State` 即可带类型读取。
