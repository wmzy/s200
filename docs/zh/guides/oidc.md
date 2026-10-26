# OIDC 登录

s200 的认证面止步于携带质询的基础件（`s200/auth`、`s200/jwt`、`s200/csrf`）——完整的 OIDC 客户端刻意做成配方而非包入口。[`recipes/oidc.ts`](https://github.com/wmzy/s200/blob/main/recipes/oidc.ts) 是仓库级 TypeScript，与 [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) 同一套约定：把这一个文件 vendor 进你的项目，自带 provider，然后注入。它实现带 PKCE（S256）的授权码流程（Authorization Code）——当前 OIDC 指南对机密客户端与公共客户端一致推荐的流程——并且组合既有 battery 而不是重新发明：签名流程 cookie（`s200/cookies`）、id_token 校验（`s200/jwt` 的 `verifyJwt`，经 `createJwksResolver` 从 discovery 的 `jwks_uri` 取键），以及向你的会话层（`s200/session`）交接令牌。

## 接线

把 `recipes/oidc.ts` vendor 进你的项目（按 `src/` 相对位置调整两处导入层级），然后接两条 GET 路由和会话中间件：

```ts
import { createApp, get, use } from 's200';
import { createSession, type Session } from 's200/session';
import { createOidc } from './oidc'; // vendored from recipes/oidc.ts

const sessions = createSession({ secret: process.env.SESSION_SECRET! });
const oidc = createOidc({
  issuer: 'https://idp.example',
  clientId: 'web-app',
  clientSecret: process.env.OIDC_SECRET,
  redirectUri: 'https://app.example/auth/callback',
  cookieSecret: process.env.COOKIE_SECRET!,
  scopes: ['openid', 'profile', 'email'],
  onLogin: (ctx, tokens, claims) => {
    const session = ctx.state.session as Session;
    session.set('user', claims.sub);
    session.set('idToken', tokens.idToken); // for the logout id_token_hint
  },
});

const app = createApp();
use(app, sessions.middleware);
get(app, '/login', oidc.login);
get(app, '/auth/callback', oidc.callback); // must be the registered redirectUri
get(app, '/logout', async (ctx) => {
  const session = ctx.state.session as Session;
  const idToken = session.get('idToken') as string | undefined;
  await session.destroy();
  const target = await oidc.logoutUrl('https://app.example/', idToken);
  return new Response(null, { status: 302, headers: { location: target ?? '/' } });
});
```

省略 `clientSecret` 时配方按公共客户端运行——没有 provider 侧的客户端密钥，PKCE 承担客户端认证。

## 流程，用文字描述

整支舞是一次浏览器跳出去、一次跳回来、一次服务器到服务器的 POST：

1. **`GET /login`** —— handler 从平台 CSPRNG 抽取三个全新的 256-bit 值：`state`、`nonce`、PKCE `code_verifier`。它以 `302` 应答 provider 的 `authorization_endpoint`，携带 `response_type=code`、`client_id`/`redirect_uri`/`scope`、明文的 `state` 与 `nonce`，以及 `code_challenge=base64url(SHA-256(verifier))` 和 `code_challenge_method=S256`。三个秘密落入签名、HttpOnly、`SameSite=Lax`、十分钟 TTL 的 cookie（`oidc.state`、`oidc.nonce`、`oidc.verifier`，各带一个按 cookie battery 约定的 `.sig` 伙伴）。
2. **在 provider 处** —— 用户完成认证与授权。provider 永远看不到 verifier；challenge 是它的单向哈希。
3. **回到 `/auth/callback`** —— provider 带着 `code` + `state` 重定向回来（或者 `error`，配方以携带 provider 错误码的 401 应答）。handler 重读三个 cookie 并校验签名，查询串里的 `state` 与 cookie 不严格一致即 401 拒绝。
4. **交换** —— 配方向 `token_endpoint` POST 一个表单体：`grant_type=authorization_code`、`code`、`redirect_uri`、`code_verifier`；provider 对 verifier 重新哈希并对照它记住的 challenge——正是这一步把 code 绑定到这个浏览器。有 `clientSecret` 时以 HTTP Basic 认证发送；没有时 `client_id` 走请求体。交换失败应答 502。
5. **校验** —— 返回的 `id_token` 用 `verifyJwt` 校验：签名经 `createJwksResolver` 从 discovery 的 `jwks_uri` 取键（kid 轮换是 resolver 的职责）、`iss` 对照配置的 issuer、`aud` 对照 `clientId`、时间声明按配置的时钟容差，`nonce` 声明对照 nonce cookie。任一失败应答 401。
6. **会话** —— `onLogin` 拿到令牌与已校验的 claims 运行；默认响应是 `302` 到 `postLoginPath`（或 `onLogin` 自己写的响应）。三个流程 cookie 随之过期。

Discovery（`{issuer}/.well-known/openid-configuration`）每个 issuer 只取一次并为进程缓存；失败的请求在下次请求时重试，不会被钉死。

## 选项

| 选项 | 默认 | 说明 |
| ---- | ---- | ---- |
| `issuer` | — | Provider issuer；尾斜杠会被归一化。Discovery 按 issuer 缓存。 |
| `clientId` | — | 同时是 id_token 必需的 `aud`。 |
| `clientSecret` | `undefined` | 有 → 机密客户端，token 请求走 HTTP Basic。无 → 公共客户端，`client_id` 走请求体。 |
| `redirectUri` | — | 在 provider 注册的回调 URL。 |
| `scopes` | `['openid']` | `openid` 使流程成为 OIDC；要 profile 数据就加 `profile`/`email`。 |
| `cookieSecret` | — | 三个流程 cookie 的 HMAC 密钥（cookie battery 的约定）。 |
| `cookieNames` | `oidc.*` | 多个应用共享同一域名时改写。 |
| `postLoginPath` | `'/'` | 回调成功后重定向到哪里。 |
| `clockTolerance` | `60` | id_token 时钟偏移容忍秒数。 |
| `fetch` | 全局 fetch | 测试与代理的注入点。注入的 fetch 获得**实例私有**的 discovery 缓存——模块级缓存只在走全局 fetch 的实例之间共享。 |
| `onLogin` | — | 接收 `(ctx, tokens, claims)`；在这里写你的会话。 |

## 安全须知

- **PKCE 无条件启用。** 每个授权请求都带 `code_challenge_method=S256`；verifier 只存在于签名 HttpOnly cookie 和那一次 token 请求里。配方绝不降级到 `plain`，也没有关闭 PKCE 的开关——对机密客户端它是纵深防御（偷走的 `code` 没有 verifier 一文不值），对公共客户端它是唯一的客户端认证。
- **Basic 与请求体两种客户端认证。** 有 `clientSecret` 时凭证放进 `Authorization: Basic` 头（RFC 6749 §2.3.1）——机密客户端的默认，也是对日志与中间件更友好的选择，因为请求体被记录的频率远高于请求头。`client_secret_post`（凭证在请求体里）不在提供之列；若你的 provider 只接受它，vendor 后一行改掉即可。
- **时钟偏移。** `verifyJwt` 按 `clockTolerance` 秒的容差（默认 60）检查 `exp`/`nbf`/`iat`。provider 时钟漂移大就调高；要严格就设 `0`。`state`/`nonce`/`verifier` 是十分钟 cookie TTL 下的单用途随机值，既不需要偏移处理也不需要服务端存储。
- **登录时轮换会话。** 配方绝不碰你的会话；`onLogin` 正是调用 `session.regenerate()` 的地方——session battery 的固定攻击防线——然后才写入用户。

## 局限

- **只支持 JWS。** 加密的 id_token（JWE——带 `enc` 头、`alg` 形如 `RSA-OAEP-256` 的令牌）不支持，校验会失败。签名令牌是 provider 的默认；两者都提供时请选签名。
- **只用 id_token claims。** 永不调用 userinfo 端点——profile 数据必须随 id_token 而来（把 scope 请求上）。
- **无刷新自动化。** `tokens.refreshToken` 原样交给 `onLogin`；刷新、存储与轮换是你的事。
- **单一 redirectUri。** 登录与交换都只用配置的那一个；没有按请求覆盖。
- **Discovery 没有 TTL。** 文档每 issuer 每进程只取一次；端点变更需要重启或注入带自有缓存策略的 `fetch`。
- **登出依赖 provider 支持。** `end_session_endpoint` 在 discovery 中是可选项；没有它 `logoutUrl()` 解析为 `undefined`，指南里的登出路由退化为只销毁本地会话。

## 刷新令牌

access token 天生短命；它过期时，登录时 provider 签发的 refresh token 无需浏览器绕行即可换一个新的——[`s200/oauth`](/zh/api/security) 的 `refreshToken`（RFC 6749 §6）就是这个 grant。配方把 `tokens.refreshToken` 原样交给 `onLogin`，所以会话是停放它的天然位置：

```ts
import { refreshToken } from 's200/oauth';

// The token endpoint — from the same discovery document the recipe caches
// internally ({issuer}/.well-known/openid-configuration).
const { token_endpoint: tokenEndpoint } = (await fetch(
  'https://idp.example/.well-known/openid-configuration'
).then((res) => res.json())) as { token_endpoint: string };

const oidc = createOidc({
  // …as in Setup…
  onLogin: (ctx, tokens, claims) => {
    const session = ctx.state.session as Session;
    session.set('user', claims.sub);
    session.set('idToken', tokens.idToken); // for the logout id_token_hint
    session.set('accessToken', tokens.accessToken);
    session.set('refreshToken', tokens.refreshToken); // present when the provider issues one
    if (tokens.expiresIn !== undefined) {
      session.set('accessTokenExpiresAt', Date.now() + tokens.expiresIn * 1000);
    }
  },
});
```

然后是一个返回可用 access token 的助手——只在存的那枚已过期时刷新（预留 30 秒余量），并且当服务器轮换 refresh token 时总是持久化新的那枚：

```ts
import { get, json } from 's200';
import { refreshToken } from 's200/oauth';

async function freshAccessToken(session: Session): Promise<string | undefined> {
  const expiresAt = session.get('accessTokenExpiresAt');
  if (typeof expiresAt === 'number' && expiresAt > Date.now() + 30_000) {
    return session.get('accessToken') as string | undefined; // still live
  }
  const current = session.get('refreshToken');
  if (typeof current !== 'string') return session.get('accessToken') as string | undefined;
  const tokens = await refreshToken(
    { tokenEndpoint, clientId: 'web-app', clientSecret: process.env.OIDC_SECRET },
    { refreshToken: current }
  );
  session.set('accessToken', tokens.accessToken);
  if (tokens.expiresIn !== undefined) {
    session.set('accessTokenExpiresAt', Date.now() + tokens.expiresIn * 1000);
  }
  if (tokens.refreshToken !== undefined) {
    session.set('refreshToken', tokens.refreshToken); // rotation — the old token is dead
  }
  return tokens.accessToken;
}

get(app, '/api/profile', async (ctx) => {
  const session = ctx.state.session as Session;
  let accessToken: string | undefined;
  try {
    accessToken = await freshAccessToken(session);
  } catch {
    // The grant failed — an expired or revoked refresh token comes back
    // invalid_grant, which refreshToken reports as a 502 HttpError.
    // The session cannot be refreshed: destroy it and re-login.
    await session.destroy();
    return new Response(null, { status: 302, headers: { location: '/login' } });
  }
  if (accessToken === undefined) {
    return new Response(null, { status: 302, headers: { location: '/login' } });
  }
  // …call the provider's API with the access token…
  return json(ctx, { ok: true });
});
```

发布前值得知道的 grant 规则：

- **scope 绝不变宽。**可选的 `scope` 参数不得超过原授权授予的范围——服务器会拒绝更宽的；省略它（如上）即保持原 scope。
- **客户端认证与 `exchangeCode` 一致。**有 `clientSecret` 走 HTTP Basic；没有则 `client_id` 走请求体——公共客户端刷新自己的 token，与它当初兑换 code 的方式相同。
- **失败即抛出。**非 2xx 应答，或缺 `access_token`/`token_type` 的载荷，抛出 502 `HttpError`——上游失败是服务器的问题，所以上面的路由把这个抛出当作"重新登录"，而不是给用户一个 500。
- **持久化轮换。**许多 provider 每次使用都轮换 refresh token；轮换出的新 token 随 `tokens.refreshToken` 返回。只要出现就持久化它——示例里那个无条件写入做的正是这件事——否则下次刷新送出的是一枚死 token。
- **`idToken` 不随之刷新。**返回的只有 access token（可能还有 refresh token）；id_token 的 claims 停留在最初登录那一次。需要新 claims 就再走一遍 `/login`。
