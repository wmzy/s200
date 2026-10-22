# 静态文件

## serveStatic

所有 I/O 都是注入的 —— 核心绝不触碰文件系统。适配器提供这些部件，但任何 `read` 都能工作（内存、S3、嵌入式）：

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),            // ETag/Last-Modified + 304s
  readRange: createFileRangeReader('public'), // streamed ranges: no whole-file buffering
  prefix: '/static',  // mount point, stripped before lookup
  spa: true,          // html navigation misses fall back to index.html
  cacheControl: 'public, max-age=3600',      // stamped on 200/206/304
}));
```

## root 与遍历

`root` 被嵌入交给 `read` 的查找路径 —— 当注入的读取器已经根植于某个目录时，保持未设置（如上）。当 `read` 函数期望带 root 前缀的键时传入它（如 `root: 'assets'`），比如内存映射。

遍历（`..`）永远逃不出 root，`index`（默认 `index.html`）服务目录路径，未命中则落到 `next()` 以便其他路由应答。隐藏文件默认被拒绝 —— 请求路径带点文件段（`.env`、`.git/…`，包括百分号编码形式）会落下而不被服务；用 `dotfiles: 'allow'` 退出。

## 符号链接

词法检查看不穿符号链接：root 内的符号链接可以指向任何地方。因此适配器的工厂函数**默认**接线 realpath 守卫 —— `createFileReader`、`createFileStat`、`createFileRangeReader` 在碰文件前都会解析每次查找，逃逸的符号链接在普通读取、stat 与 `Range` 请求上同样不可达。`null` 只保留给这一种情况：逃逸的真实路径（或无法解析的 root）像拒绝一样落下；仅仅不存在的路径则按其解析出的（不存在的）路径返回 —— 未命中不是逃逸，目录重定向与 SPA 回退仍会执行。自带 `read` 函数时守卫由你负责（同样方式注入适配器的 `createRealPathGuard`）；它每次请求花费一次 realpath，`createFileReader(root, { realPath: false })` 可在确认无符号链接时关闭：

```ts
import { createRealPathGuard } from 's200/node';   // or 's200/bun'

use(app, serveStatic({ …, realPath: createRealPathGuard('public') }));
```

## 范围与条件请求

字节读取器支持单字节范围（`Range: bytes=…` → 206，或不满足时 416），因此视频拖动可以工作 —— 但缓冲读取会把文件持有在内存中。适配器的 `createFileReader` 对此有界：超过 `streamThreshold`（默认 16 MiB）的文件走流式路径（`{ stream: true }` 仍然强制全量流式），注入 `readRange` 后大文件的范围请求也流式切片读取。`stat` 另外开启条件请求：响应携带 `ETag`/`Last-Modified`，`If-None-Match`/`If-Modified-Since` 命中回答 304。目录路径缺少尾斜杠且目录索引存在时，回答 301 到带斜杠形式（退出：`redirectToSlash: false`）。
