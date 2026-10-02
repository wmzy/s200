# 静态文件

所有 I/O 都是注入的 —— 核心绝不触碰文件系统。适配器自带这些部件（`s200/node` 或 `s200/bun`），但任何 `read` 都可以工作：内存、S3、内嵌。

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),             // ETag/Last-Modified + 304
  readRange: createFileRangeReader('public'),  // 流式范围读取：不整文件缓冲
  prefix: '/static',   // 挂载点，查找前剥离
  spa: true,           // html 导航未命中时回退到 index.html
  cacheControl: 'public, max-age=3600',        // 盖在 200/206/304 上
}));
```

遍历（`..`）永远逃不出根目录，`index`（默认 `index.html`）服务目录路径，未命中则落到 `next()`，让其他路由来应答。隐藏文件默认被拒绝 —— 带点文件段的请求路径（`.env`、`.git/…`，包括百分号编码形式）会直接落穿而不被服务（`dotfiles: 'allow'` 可退出该行为）。当服务根目录可能包含符号链接时，注入适配器的 `createRealPathGuard`，让根外的真实路径像未命中一样落穿。

`stat` 还开启条件请求：响应携带 `ETag`/`Last-Modified`，`If-None-Match`/`If-Modified-Since` 命中时回答 `304`。字节读取器支持单字节范围（`Range: bytes=…` → 206，无法满足时 416），因此视频拖动进度可用；大媒体文件可以让 `read` 返回 `ReadableStream`，`readRange` 流式切片读取。

完整参考：[README 中的静态文件](https://github.com/wmzy/s200#static-files)。
