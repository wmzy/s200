import { defineConfig } from 'vitepress';

export default defineConfig({
  // Project pages serve from /s200/ (wmzy/s200). Only applied in CI so
  // `pnpm docs:dev` and `docs:preview` keep serving from / locally.
  base: process.env.GITHUB_ACTIONS ? '/s200/' : '/',
  title: 's200',
  description:
    'Data + functions server framework on the Web Standard: koa-style onion middleware, hono-style multi-runtime portability, replaceable modules, fully tree-shakable. Zero dependencies.',
  head: [
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23646cff'/%3E%3Ctext x='32' y='45' font-family='system-ui,sans-serif' font-size='30' font-weight='700' fill='white' text-anchor='middle'%3Es200%3C/text%3E%3C/svg%3E",
      },
    ],
  ],
  locales: {
    root: { label: 'English' },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description:
        '构建在 Web Standard 之上的数据 + 函数服务端框架：koa 风格洋葱中间件、hono 风格多运行时可移植、可替换模块、完全 tree-shakable。零依赖。',
      themeConfig: {
        // VitePress ships no built-in zh strings — translate the default
        // theme chrome here.
        outline: { label: '页面导航' },
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        lastUpdatedText: '上次更新',
        editLink: {
          pattern: 'https://github.com/wmzy/s200/edit/main/docs/:path',
          text: '在 GitHub 上编辑此页',
        },
        footer: {
          message: '基于 MIT 许可证发布。',
          copyright: 'Copyright © 2026-present wmzy',
        },
        nav: [
          { text: '首页', link: '/zh/' },
          { text: '文档', link: '/zh/getting-started' },
          { text: '指南', link: '/zh/guides/routing' },
          { text: '对比', link: '/zh/comparison' },
          { text: '基准测试', link: '/zh/benchmarks' },
        ],
        sidebar: [
          {
            text: '快速开始',
            items: [{ text: '简介', link: '/zh/getting-started' }],
          },
          {
            text: '指南',
            items: [
              { text: '路由', link: '/zh/guides/routing' },
              { text: '中间件', link: '/zh/guides/middleware' },
              { text: '响应', link: '/zh/guides/responding' },
              { text: '请求体解析', link: '/zh/guides/body' },
              { text: '静态文件', link: '/zh/guides/static-files' },
              { text: '错误', link: '/zh/guides/errors' },
              { text: '适配器', link: '/zh/guides/adapters' },
              { text: '电池模块', link: '/zh/guides/batteries' },
              { text: '包导出清单', link: '/zh/guides/package-surface' },
              { text: '编写电池模块', link: '/zh/guides/battery-authoring' },
              { text: '分布式存储', link: '/zh/guides/distributed-stores' },
              { text: '分片与调度', link: '/zh/guides/sharding' },
            ],
          },
          {
            text: '生态',
            items: [{ text: '电池模块注册表', link: '/zh/ecosystem' }],
          },
          {
            text: '稳定性',
            items: [{ text: '契约与版本管理', link: '/zh/stability' }],
          },
          {
            text: '对比',
            items: [{ text: '与其他框架对比', link: '/zh/comparison' }],
          },
          {
            text: '基准测试',
            items: [{ text: '数据与方法论', link: '/zh/benchmarks' }],
          },
          {
            text: '迁移',
            items: [
              { text: '从 Express', link: '/zh/migration-from-express' },
              { text: '从 Koa', link: '/zh/migration-from-koa' },
              { text: '从 Hono', link: '/zh/migration-from-hono' },
            ],
          },
        ],
      },
    },
  },
  themeConfig: {
    // Local search builds a per-locale index at build time; the zh
    // button text comes from options.locales.
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: { translations: { button: { buttonText: '搜索' } } },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/wmzy/s200' }],
    editLink: {
      pattern: 'https://github.com/wmzy/s200/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    lastUpdated: true,
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026-present wmzy',
    },
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Docs', link: '/getting-started' },
      { text: 'Guides', link: '/guides/routing' },
      { text: 'Comparison', link: '/comparison' },
      { text: 'Benchmarks', link: '/benchmarks' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [{ text: 'Introduction', link: '/getting-started' }],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Routing', link: '/guides/routing' },
          { text: 'Middleware', link: '/guides/middleware' },
          { text: 'Responding', link: '/guides/responding' },
          { text: 'Body Parsing', link: '/guides/body' },
          { text: 'Static Files', link: '/guides/static-files' },
          { text: 'Errors', link: '/guides/errors' },
          { text: 'Adapters', link: '/guides/adapters' },
          { text: 'Batteries', link: '/guides/batteries' },
          { text: 'Package Surface', link: '/guides/package-surface' },
          { text: 'Battery Authoring', link: '/guides/battery-authoring' },
          { text: 'Distributed Stores', link: '/guides/distributed-stores' },
          { text: 'Sharding & Scheduling', link: '/guides/sharding' },
        ],
      },
      {
        text: 'Ecosystem',
        items: [{ text: 'Battery registry', link: '/ecosystem' }],
      },
      {
        text: 'Stability',
        items: [{ text: 'Contracts & versioning', link: '/stability' }],
      },
      {
        text: 'Comparison',
        items: [{ text: 'vs other frameworks', link: '/comparison' }],
      },
      {
        text: 'Benchmarks',
        items: [{ text: 'Numbers & methodology', link: '/benchmarks' }],
      },
      {
        text: 'Migration',
        items: [
          { text: 'From Express', link: '/migration-from-express' },
          { text: 'From Koa', link: '/migration-from-koa' },
          { text: 'From Hono', link: '/migration-from-hono' },
        ],
      },
    ],
  },
});
