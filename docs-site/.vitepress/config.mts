import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 's200',
  description:
    'Data + functions server framework on the Web Standard: koa-style onion middleware, hono-style multi-runtime portability, replaceable modules, fully tree-shakable. Zero dependencies.',
  themeConfig: {
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
          { text: 'Batteries', link: '/guides/batteries' },
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
