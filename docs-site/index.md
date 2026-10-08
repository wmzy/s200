---
# Site-only page (no docs/ source); suppress the GitHub edit link.
layout: home
editLink: false

hero:
  name: s200
  text: Data + functions, on the Web Standard
  tagline: "Data + functions server framework on the Web Standard: koa-style onion middleware, hono-style multi-runtime portability, replaceable modules, fully tree-shakable. Zero dependencies."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: API Reference
      link: /api/core
    - theme: alt
      text: GitHub
      link: https://github.com/wmzy/s200

features:
  - icon: 🧩
    title: Data + functions paradigm
    details: "An application is plain data — routes, middlewares, config. Behavior never hangs off it: every capability is a top-level function taking the app (or request context) as its first argument."
  - icon: 🪶
    title: Zero dependencies
    details: No runtime dependencies at all. The core only touches Web Standard Request/Response.
  - icon: ✂️
    title: Fully tree-shakable batteries
    details: cors, logger, compress, websocket, jwt and friends live in separate entries — importing one pulls only it, the core stays lean.
  - icon: 🌍
    title: Multi-runtime
    details: node · bun · deno · edge. Adapters for s200/node, s200/bun, s200/deno and s200/cloudflare; the core consumes Web Standard Request/Response directly.
  - icon: 🛡️
    title: Typed client from the route table
    details: "createClient(app) derives a type-safe fetch client from the app's own route table — paths restricted to registered pattern literals, params typed from them, bodies typed from schema inputs, declared error branches unioned into json() and status."
  - icon: 🌲
    title: Indexed trie router
    details: Dispatch runs over a static-prefix trie indexed by every static segment — matching cost tracks URL depth, not route count.
  - icon: ⚡
    title: Opt-in light fast path
    details: "serve(app, { light: true }) swaps in duck-typed request/response objects and writes byte-backed bodies straight to the socket — ~1.35–1.4× with zero global patching."
  - icon: 🧯
    title: In-chain error boundary
    details: "404/405/500 fallbacks and error responses are materialized inside the chain — loggers, CORS and request-id stamp the real response on the unwind, never a phantom one."
  - icon: 🔌
    title: Zero-dependency WebSocket
    details: "An in-house RFC 6455 server for node and Bun — subprotocols, permessage-deflate, heartbeat, and WSS over TLS. No ws, no bridge package."
---
