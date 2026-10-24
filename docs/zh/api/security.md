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

无会话同步令牌：HMAC 签名（`nonce` + 过期期），只有你的密钥能铸造，经 cookie 传递，在非安全请求上对**头部/表单字段**与请求 `Origin` 双重校验 —— `Origin` 缺席时（同源表单提交常不带它）退回 `Sec-Fetch-Site: cross-site` 直接拒绝，`same-origin`/`same-site`/`none` 放行到令牌校验（堵死两个经典双重提交漏洞）：

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
| `bind` | — | 返回请求级绑定值（如会话 id）的回调，铸造**与**校验时都折进令牌 HMAC —— 为其他会话/用户铸造的令牌不再通过校验 |
| `path` / `sameSite` / `httpOnly` / `secure` | `'/'` / `'lax'` / `true` / — | cookie 属性；保持 `httpOnly` 并经端点或服务端渲染表单传递令牌 |

`Csrf`：`{ middleware, token, issueToken }` —— `middleware` 在安全请求上保证 `ctx.state.csrfToken` 有有效令牌（需要时刷新 cookie —— 为其他 `bind` 值铸造的也一并换新），在非安全请求上校验 `Origin`/`Sec-Fetch-Site` + 提交的令牌（就地 403）；`token(ctx)` 返回请求的有效 cookie 令牌（或新铸的）用于嵌入表单；`issueToken(ctx)` 为当前请求铸造**全新**令牌（新 nonce、完整 TTL、当前 `bind` 值），middleware 会在 unwind 时把它持久化为响应 cookie —— 非安全响应也包括，这就是登录时轮换的原语。铸造是无状态的：旧令牌在自身到期前仍然有效，让旧令牌真正退役要靠 `bind` 配合新的会话 id。

## 认证（`s200/auth`）

`basicAuth` / `bearerAuth` 闸门：`verify` 函数裁决；失败抛出携带 `WWW-Authenticate` 质询的 401 `HttpError` 进入错误边界 —— 默认映射应答 `401 {"error":"Unauthorized"}` + 质询，配置了 `onError` 时由其接管。其下链条永不运行。`verify` 内的凭据比较是你的责任 —— 密钥请用常量时间比较。

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
| `createJwksResolver(url, options?)` | 基于 JWKS 端点构建 `KeyResolver` —— 拉取、缓存（`ttlMs`，默认 5 分钟）、按 `kid` 选取；未过期缓存上 `kid` 未命中会在一个冷却窗口（`min(ttlMs, 30s)`）内至多强制重拉一次再判失败（轮换竞态；仍未命中该 `kid` 的重拉不会动缓存文档及其刷新期限）；按 URL 模块级缓存，LRU 上限 50 个端点 |
| `isJwtError(error)` | `JwtError` 谓词 |

| 类型 | 含义 |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| … \| 'ES512'` |
| `JwtKey` | `string \| Uint8Array \| CryptoKey \| JsonWebKey` |
| `JwtSignOptions` | `{ alg?, expiresIn?, notBefore?, issuedAt? \| false, audience?, issuer?, subject?, jwtId? }` —— 用 `CryptoKey`/JWK 签名时 `alg` 必填 |
| `JwtVerifyOptions` | `{ algorithms?, audience?, issuer?, clockTolerance?, requireExpiry?, keyStore? }` —— `alg:none` 无条件拒绝 |
| `RegisteredClaims` | `{ iat?, exp?, nbf?, iss?, sub?, aud?, jti? }` |
| `JwtHeader` | `{ alg, kid? }` —— `KeyResolver` 所见 |
| `KeyResolver` | `(header: JwtHeader) => JwtKey \| Promise<JwtKey>` |
| `JwtKeyStore` | `{ get(key), set(key, promise) }` —— 密钥导入缓存；默认进程内 LRU，上限 100 条。键是密钥材料的 SHA-256 十六进制摘要（绝不含原始密钥）；值是进程内、不可导出的 `CryptoKey` |
| `JwksOptions` | `{ ttlMs?, fetchFn?, store? }` |
| `JwksStore` | `{ get(url), set(url, entry) }` —— JWKS 文档缓存；默认进程内 LRU，上限 50 个 URL |
| `JwksEntry` | `{ exp, keys }` —— 一份缓存文档；`exp` 为 ms 纪元的刷新截止时间 |
| `JwtAuthOptions` | `{ secret?, key?, keyResolver?, jwks?, keyStore?, algorithms?, audience?, issuer?, clockTolerance?, requireExpiry?, header?, prefix?, cookie?, verify? }` —— `jwtAuth` 闸门的选项（见下表） |

`JwtAuthOptions`（`jwtAuth` 闸门）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `secret` | — | HMAC 密钥（`string` 或字节）—— 未提供 `verify` 时，`secret`/`key`/`keyResolver`/`jwks` 之一必填 |
| `key` | — | 静态密钥材料（RS/PS/ES 用 `CryptoKey`/JWK，HS 用密钥） |
| `keyResolver` | — | 逐令牌密钥解析（轮换、多发行方） |
| `jwks` | — | JWKS 端点 —— `string` 或 `{ url, ttlMs?, store? }`；`createJwksResolver` 的简写 |
| `algorithms` | 全部支持 | 闸门接受的算法 |
| `audience` | — | 要求的受众 —— 令牌的 `aud` 必须与之相交 |
| `issuer` | — | 要求的发行方 |
| `clockTolerance` | `0` | `exp`/`nbf`/`iat` 的时钟偏移容忍（秒） |
| `requireExpiry` | `false` | 拒绝不携带数字 `exp` 声明的令牌 |
| `header` | `'authorization'` | 承载令牌的头 |
| `prefix` | `'Bearer '` | 从头值中剥离的方案前缀 |
| `cookie` | — | 头缺失时回退的 cookie 名 |
| `verify` | — | 自定义校验（另一个库、奇异令牌）—— 返回值存入 `ctx.state.jwt` |
| `keyStore` | — | 转发给 `verifyJwt` 的密钥导入 store；绕过默认的进程内缓存（摘要键、进程内 `CryptoKey` 值） |

密钥族必须与头部算法匹配（HS 需要密钥，RS/PS 需要 RSA 密钥，ES 需要 EC 密钥 —— 混淆攻击在结构上被封死）。`jwtAuth` 的密钥来源：`secret`、`key`、`keyResolver`、`jwks`（`string` 或 `{ url, ttlMs?, store? }`），或自定义 `verify`（另一个库、奇异令牌 —— 返回值落到 `ctx.state.jwt`）。

两个模块级缓存都是有界 LRU —— **导入密钥 100 条**、**JWKS 端点 50 个**。越过上限即淘汰最久未用的条目（被淘汰的密钥按需重新导入、文档按需重新拉取），攻击者可控的密钥材料或 issuer URL 集合无法让内存无限增长。可信 issuer 超过 50 个的多租户部署 —— 或希望跨实例共享 JWKS 文档缓存的集群 —— 应注入自己的 store：`createJwksResolver` 与 `jwks` 简写接收按 `{ exp, keys }` 条目存取的 `JwksStore`（读取时 TTL 刷新语义不变），这些条目是纯 JSON，因此 Redis 支撑的 `JwksStore` 确实能跨进程共享文档。`JwtKeyStore` 不同：它的值是 `Promise<CryptoKey>` —— 进程内、不可导出的句柄，无法序列化、无法送进 Redis —— 所以 `verifyJwt` 的 `keyStore`（以及转发它的 `jwtAuth` 同名选项）定制的是进程内的导入缓存（它的上限、淘汰策略，或由进程自行导入的 id→密钥材料映射）。缓存键是密钥材料的 SHA-256 十六进制摘要，绝不含原始密钥，因此持久化或记录键的 store 不会泄露密钥。注入的 store 完全绕过进程内默认缓存并自管上限 —— 与 rate-limit/session 的 store 一样可以用 Redis 支撑。

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));
// 密钥轮换：use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// 外部共享/外部设限：use(app, jwtAuth({ jwks: { url, store: redisJwksStore } }));
```

## 安全头（`s200/secure-headers`）

安全默认基线，在 unwind 时盖上（回退响应也包含）；响应已有的头绝不覆盖，`false` 则移除某项：

```ts
use(app, secureHeaders());  // nosniff、DENY 框架嵌入、strict-origin-when-cross-origin、COOP/CORP same-origin
```

`SecureHeadersOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `xContentTypeOptions` | `'nosniff'` | `false` 移除 |
| `xFrameOptions` | `'DENY'` | 需要嵌入的应用用 `SAMEORIGIN`（或 CSP frame-ancestors 策略） |
| `referrerPolicy` | `'strict-origin-when-cross-origin'` | |
| `strictTransportSecurity` | 关 | 显式开启 —— 在 TLS 终止代理之后，stray HSTS 头可能把域名钉死在坏配置上 |
| `contentSecurityPolicy` | 关 | 显式开启 —— 原始头值或指令对象 |
| `permissionsPolicy` | 关 | 显式开启 —— 与 CSP 相同的形状 |
| `crossOriginOpenerPolicy` | `'same-origin'` | `false` 移除 |
| `crossOriginResourcePolicy` | `'same-origin'` | `false` 移除 |
| `crossOriginEmbedderPolicy` | 关 | 显式开启 —— COEP 要求每个子资源经 CORP/CORS 加入，而 CDN 图片/脚本在发出 CORP 头之前通常会被它弄坏 |
| `xDnsPrefetchControl` | 关 | 显式开启（如 `'off'`） |
| `removeHeaders` | 无 | 从每个响应剥离的头 —— 基线默认与 handler 设置的头一视同仁，如 `['x-powered-by']` |

指令对象形式按 CSP 风格序列化：`key value`（数组空格连接）、指令间以 `; ` 连接、键按插入顺序、空数组渲染为裸键 —— `{ 'default-src': ["'self'"], 'upgrade-insecure-requests': [] }` 变成 `default-src 'self'; upgrade-insecure-requests`。Permissions-Policy 的括号逗号语法（`camera=(), geolocation=(self)`）传原始字符串即可。

`cspNonce(): string` —— 加密随机的 128 位标准 base64 nonce（24 字符），用于 `'nonce-…'` CSP 源。在注册于 `secureHeaders` 之后的中间件里每请求生成一个 —— 它的 unwind 先运行，因此每请求 CSP 先于静态 fill-only 传递落位：

```ts
use(app, secureHeaders());
use(app, async (ctx, next) => {
  const nonce = cspNonce();
  await next();
  ctx.res?.headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'nonce-${nonce}'`,
  );
});
```

把同一 nonce 嵌进 HTML（`<script nonce="…">`），让策略与标记一致。

## 限流（`s200/rate-limit`）

按客户端密钥的真滑动窗口闸门：每次命中在落地 `windowMs` 后过期（无固定边界，因此窗口边缘无法突发）。超限请求抛出 429 `HttpError` 进入错误边界 —— 默认映射应答 `429 {"error":"Too Many Requests"}` + `Retry-After`，配置了 `onError` 时由其接管；其下链条永不运行。

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
| `store` | 每密钥进程内双端队列 | 跨实例共享计数：一个 `RateLimitStore` —— `hit(key, now, limit, windowMs) => RateLimitHit \| Promise<RateLimitHit>` —— 必须按键原子（Redis INCR + PEXPIRE 形状） |

`RateLimitHit`：`{ count: number; retryAt: number }` —— 存活计数与最早可重试时间。默认存储是每实例的；共享限流需要注入 `store`。

429 响应在 `Retry-After` 之外携带 IETF 限流头（`RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset` —— draft-ietf-httpapi-ratelimit-headers）：整数字符串，分别为限额 / 被拦截时的 `0` / 最早阻断命中过期前的剩余秒数（与 `Retry-After` 同一余量）。与所有 HTTP/2 响应头一样，线上名称为小写。

## 信任代理（`s200/trust-proxy`）

从 `X-Forwarded-Proto`/`X-Forwarded-Host` 修正 `ctx.url` 的协议/主机，并在 `ctx.state.proxy` 记录客户端地址，`X-Forwarded-For` 按跳计数（从右向左选取，跳过非可信跳）。把它注册在 `s200/csrf`、`s200/secure-headers` 以及一切构造绝对 URL 的功能**之前**：

```ts
use(app, trustProxy({ hops: 1 }));   // 位于一个可信反向代理之后
```

`TrustProxyOptions`：`{ hops?（默认 1）, protoHeader?, hostHeader?, forHeader? }`。`ctx.state.proxy` 条目（`TrustProxyInfo`）：`{ proto?, host?, clientIp? }` —— 用 `TrustProxyState` 增强 `State` 即可带类型读取。
