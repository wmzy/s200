---
# 仅站点页面（docs/ 中无源文件）——隐藏 GitHub 编辑链接。
layout: home
editLink: false

hero:
  name: s200
  text: 数据 + 函数，构建在 Web Standard 之上
  tagline: "构建在 Web Standard 之上的数据 + 函数服务端框架：koa 风格洋葱中间件、hono 风格多运行时可移植、可替换模块、完全 tree-shakable。零依赖。"
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/getting-started
    - theme: alt
      text: API 参考
      link: /zh/api/core
    - theme: alt
      text: GitHub
      link: https://github.com/wmzy/s200

features:
  - icon: 🧩
    title: 数据 + 函数范式
    details: "应用就是普通数据 —— 路由、中间件、配置。行为绝不挂在数据上：每个能力都是一个以应用（或请求上下文）为首参数的顶层函数。"
  - icon: 🪶
    title: 零依赖
    details: 完全没有运行时依赖。核心只接触 Web Standard 的 Request/Response。
  - icon: ✂️
    title: 完全 tree-shakable 的电池模块
    details: cors、logger、compress、websocket、jwt 等都住在独立的包入口 —— 只导入用到的那个，核心保持精简。
  - icon: 🌍
    title: 多运行时
    details: node · bun · deno · edge。提供 s200/node、s200/bun、s200/deno、s200/cloudflare 的适配器；核心直接消费 Web Standard 的 Request/Response。
  - icon: 🛡️
    title: 由路由表派生的类型安全客户端
    details: "createClient(app) 从应用自身的路由表派生出类型安全的 fetch 客户端 —— 路径限定为已注册的模式字面量、参数类型由其推导、请求体类型来自 schema 输入、声明的错误分支并入 json() 与状态码。"
  - icon: 🌲
    title: 带索引的 trie 路由器
    details: 分发运行在按「每个静态段」建索引的静态前缀 trie 上 —— 匹配成本跟随 URL 深度，而非路由数量。
  - icon: ⚡
    title: 可选的轻量快速路径
    details: "serve(app, { light: true }) 换上鸭子类型的请求/响应对象，把带字节背书的响应体直接写入 socket —— 约 1.35–1.4× 提升，且零全局补丁。"
  - icon: 🧯
    title: 链内错误边界
    details: "404/405/500 回退与错误响应都在链内物化 —— logger、CORS 与 request-id 在 unwind 时盖在真实响应上，绝不会是幻影响应。"
  - icon: 🔌
    title: 零依赖 WebSocket
    details: "node 与 Bun 自研的 RFC 6455 服务端 —— 子协议、permessage-deflate、心跳、TLS 之上的 WSS。不需要 ws，不需要桥接包。"
---
