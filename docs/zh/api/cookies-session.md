# Cookie 与会话（`s200/cookies`、`s200/session`）

纯函数的 Cookie 读/写/签名，以及基于签名不透明 id 的服务端会话。

## Cookie（`s200/cookies`）

写入追加一条规范的 `Set-Cookie` 头（多次调用保持独立头，绝不逗号连接）；在响应存在之后调用 —— 自然位置是 unwind，即 `await next()` 之后：

```ts
use(app, async (ctx, next) => {
  await next();
  setCookie(ctx, 'theme', 'dark', { httpOnly: true, sameSite: 'lax', maxAge: 86400 });
});
await setSignedCookie(ctx, 'sid', userId, SECRET);          // + sid.sig HMAC 伙伴
const sid = await getSignedCookie(ctx, 'sid', SECRET);      // 未验证通过则 undefined
```

| 函数 | 含义 |
| --- | --- |
| `getCookie(ctx, name)` | 读取一个 cookie（解码后）；缺失或畸形对返回 `undefined` |
| `setCookie(ctx, name, value, options?)` | 追加 `Set-Cookie` 头；响应尚不存在时**抛错** |
| `signCookie(value, secret)` | `value.sig` —— 值的 HMAC-SHA256 签名 |
| `verifyCookieSignature(value, sig, secret)` | 常量时间验证；不匹配返回 `false` |
| `setSignedCookie(ctx, name, value, secret, options?)` | 设置 `name=value` 及 `name.sig` 伙伴 cookie |
| `getSignedCookie(ctx, name, secret)` | 签名通过验证时返回值，否则 `undefined` |
| `timingSafeEqual(a, b)` | 常数时间字符串比较 —— `s200/auth` 的 verify 回调应使用的原语 |

`CookieOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxAge` | — | 寿命（秒）→ `Max-Age` |
| `expires` | — | 绝对过期 → `Expires`（RFC 1123） |
| `domain` / `path` | — / `'/'` | 作用域 |
| `secure` / `httpOnly` | — / `false` | cookie 标志 |
| `sameSite` | — | `'strict' \| 'lax' \| 'none'` |
| `partitioned` | — | Chrome CHIPS —— 发出 `Partitioned` 属性 |

Cookie 名遵循 RFC 6265 token 字母表（比值更严格）；值在读取时百分号解码。

## 会话（`s200/session`）

`createSession({ secret, store? })` 返回一个中间件（外加 `close()` 用于默认存储的清扫定时器）。客户端只持有经签名的 opaque id（HMAC 经 cookies 电池 —— 全框架一套签名约定）；数据放在服务端可插拔的 `store` 里。被篡改、缺失或过期的 id 表现一致：一个全新空会话，绝不报错。

变更（`set`/`delete`/`clear`/`touch`）在 unwind 时持久化并（重新）签发 cookie；`destroy()` 从存储删除并过期 cookie；`regenerate()` 轮换到新 id 且旧 id 当场删除；只读请求不留痕迹 —— 无存储写入、无 `Set-Cookie`。

```ts
const { middleware, close } = createSession({ secret: SECRET, cookie: { maxAge: 3600 } });
use(app, middleware);
get(app, '/', (ctx) => {
  const session = ctx.state.session as Session;
  session.set('user', 'alice');            // unwind 时持久化 + 签发 cookie
  return json(ctx, { visits: session.get('visits') });
});
```

`SessionOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `secret` | （必填） | HMAC 密钥 —— 与 cookies 电池签名同种密钥材料 |
| `cookie` | — | `SessionCookieOptions`（见下） |
| `store` | 进程内 Map，惰性过期 + 周期性 unref 清扫 | `SessionStore`（见下） —— Redis `SET … EX` 形状 |
| `key` | `'session'` | 会话对象的 `ctx.state` 槽位 |
| `now` | `Date.now` | 时钟覆盖（测试、确定性重放） |

`SessionCookieOptions`：`{ name?（'s200.sid'，签名伙伴 `.sig`）, maxAge?（86_400）, httpOnly?（true）, sameSite?, path?, secure?, domain? }`。

`SessionStore`：`get(id)`、`set(id, data, ttlSeconds)`、`delete(id)` —— 各可返回值或 promise；`set` 收到 cookie 宣告的 TTL，使共享存储把数据与 cookie 一同过期。

`Session`（挂在 `ctx.state[key]`）：

| 成员 | 含义 |
| --- | --- |
| `id` | 已恢复的会话 id；unwind 铸造前为 `undefined` |
| `isNew` | 本请求内稳定 —— 无有效 cookie + 存储命中恢复数据时为 true |
| `get(key)` / `set(key, value)` / `delete(key)` / `clear()` | 数据访问；变更在 unwind 时持久化 |
| `touch()` | 续期已有会话的过期时间（新会话为 no-op） |
| `regenerate(keepData?)` | 登录/提权时的会话固定防御：轮换到新 id（旧 id 立即从存储删除 —— 即使响应永远没能送达，被盗 cookie 也已作废），unwind 在新 id 下持久化并（重新）签发 cookie。默认丢弃数据（express-session 语义）；`regenerate(true)` 保留。`isNew` 保持本请求内的稳定值；`destroy()` 之后为 no-op |
| `destroy()` | 从存储删除；unwind 过期 cookie。终局性 —— `destroy()` 之后的变更被丢弃 |

`SessionData`：`Record<string, unknown>` —— 普通 JSON 形状记录，对存储不透明。

### 登录轮换

`regenerate()` 是会话固定防御：攻击者在登录前固定到浏览器上的 id，会在登录轮换的那一刻从存储里死掉。它与 CSRF 电池的 `bind` 天然搭配 —— 把会话 id 折进 token 的 HMAC，为旧 id 铸造的 token 随轮换一并退役：

```ts
const csrf = createCsrf({
  secret: SECRET,
  bind: (ctx) => (ctx.state.session as Session).id ?? '',
});

post(app, '/login', async (ctx) => {
  const session = ctx.state.session as Session;
  await session.regenerate();   // 新 id，数据丢弃
  session.set('user', 'alice'); // 登录升级本身
  await csrf.issueToken(ctx);   // 绑定到新 id 的全新 token
  return json(ctx, { ok: true });
});
```
