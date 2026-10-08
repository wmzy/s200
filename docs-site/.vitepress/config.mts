import { defineConfig } from 'vitepress';

export default defineConfig({
  // Populate page.headers (useData().page.headers). The default
  // theme's outline reads rendered headings from the DOM and local
  // search splits its own HTML, but page data stays empty without
  // this — the upstream default (opt-in since 1.x).
  markdown: { headers: true },
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
        langMenuLabel: '切换语言',
        skipToContentLabel: '跳至主要内容',
        notFound: {
          title: '页面未找到',
          quote:
            '但如果你不改变方向，继续寻找下去，也许最终会抵达你正前往的地方。',
          linkText: '回到首页',
          linkLabel: '回到首页',
        },
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
          { text: 'API', link: '/zh/api/core' },
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
            text: 'API 参考',
            items: [
              { text: '核心', link: '/zh/api/core' },
              { text: '响应 · 请求体 · 静态文件', link: '/zh/api/respond' },
              { text: 'Node 适配器', link: '/zh/api/node' },
              { text: 'Bun 适配器', link: '/zh/api/bun' },
              { text: 'Edge 适配器', link: '/zh/api/edge' },
              { text: '请求接入', link: '/zh/api/request' },
              { text: '安全', link: '/zh/api/security' },
              { text: 'Cookie 与会话', link: '/zh/api/cookies-session' },
              { text: '响应电池', link: '/zh/api/response-batteries' },
              { text: '可观测性', link: '/zh/api/observability' },
              { text: '数据与配置', link: '/zh/api/data' },
              { text: 'WebSocket', link: '/zh/api/websocket' },
              { text: 'OpenAPI 与工具', link: '/zh/api/openapi' },
              { text: '生命周期 · 健康 · 热重载', link: '/zh/api/lifecycle' },
              { text: '分片与执行', link: '/zh/api/sharding' },
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
    // strings come from options.locales.
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '重置搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到与',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车',
                  navigateText: '切换',
                  navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头',
                  closeText: '关闭',
                  closeKeyAriaLabel: '退出',
                },
              },
            },
          },
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
      { text: 'API', link: '/api/core' },
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
        text: 'API Reference',
        items: [
          { text: 'Core', link: '/api/core' },
          { text: 'Responding · Bodies · Static', link: '/api/respond' },
          { text: 'Node Adapter', link: '/api/node' },
          { text: 'Bun Adapter', link: '/api/bun' },
          { text: 'Edge Adapters', link: '/api/edge' },
          { text: 'Request Intake', link: '/api/request' },
          { text: 'Security', link: '/api/security' },
          { text: 'Cookies & Sessions', link: '/api/cookies-session' },
          { text: 'Response Batteries', link: '/api/response-batteries' },
          { text: 'Observability', link: '/api/observability' },
          { text: 'Data & Config', link: '/api/data' },
          { text: 'WebSocket', link: '/api/websocket' },
          { text: 'OpenAPI & Tooling', link: '/api/openapi' },
          { text: 'Lifecycle · Health · Hot Reload', link: '/api/lifecycle' },
          { text: 'Sharding & Execution', link: '/api/sharding' },
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
