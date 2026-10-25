# Contributing to s200

Thanks for considering a contribution. This document is the short path from clone to PR; the [documentation site](https://wmzy.github.io/s200/) covers everything else.

## Development setup

```sh
git clone https://github.com/wmzy/s200.git
cd s200
pnpm install
```

- **Toolchain Node ≥ 22** — CI (`.github/workflows/ci.yml`) runs lint, tests, and builds on Node 22. Enable it via [corepack](https://nodejs.org/api/corepack.html) (`corepack enable`); the pinned package manager is `pnpm@11.28.0` (see `packageManager` in `package.json`).
- **The published package floor is Node ≥ 20.3** (`engines`). That floor is the *runtime* floor, not the toolchain floor — vite/vitest themselves may need newer Node. CI proves the floor with a dedicated job: install and build on Node 22, then run the dependency-free `scripts/smoke-floor.mjs` under Node 20.3 and 24. You rarely need to replicate that locally; plain `pnpm build && node scripts/smoke-floor.mjs` is enough if you touch the adapters or entry points.
- [Bun](https://bun.sh) is needed for the full `pnpm smoke` (the smoke script runs under node **and** bun — bun also exercises the `s200/websocket/bun` bridge).

## Scripts

Verified against `package.json`:

| Script | What it does |
| --- | --- |
| `pnpm build` | Vite library build (ES + CJS, every package entry tree-shaken) + `.d.ts`/`.d.mts` emission + CLI bin fixup |
| `pnpm test` | `vitest run` — full suite; cap with `--maxWorkers` (see test discipline below) |
| `pnpm start` | `vitest watch` |
| `pnpm coverage` | Full suite with LCOV coverage |
| `pnpm typecheck` | `tsc --noEmit` over the strict config (includes `test/`) |
| `pnpm lint` / `pnpm lint:ci` | ESLint on `src` + `test` (`lint` auto-fixes, `lint:ci` doesn't) |
| `pnpm check:paradigm` | Enforces the data + functions paradigm in `src/` (see below) |
| `pnpm verify:tree-shaking` | Asserts unused modules (e.g. body, static) are actually shaken out of a minimal bundle |
| `pnpm size` | `size-limit` — byte budgets per package entry |
| `pnpm attw` | `arethetypeswrong` — catches ESM/CJS type-resolution breaks |
| `pnpm lint:pkg` | `publint --strict` — package.json exports sanity |
| `pnpm smoke` | Runs `scripts/smoke.mjs` + `scripts/smoke-dev.mjs` under node, then `scripts/smoke.mjs` under bun |
| `pnpm bench` | Router dispatch micro-benchmark (`scripts/bench-router.mjs`; `ROUTES`/`ITERATIONS` env) |
| `pnpm bench:http` | Whole-request throughput vs hono/express/fastify/elysia in isolated processes |
| `pnpm bench:memory` | Memory footprint benchmark |
| `pnpm docs:dev` / `docs:build` / `docs:preview` | VitePress site (`docs-site/`) |
| `pnpm commit` | `lint-staged` + commitizen (`cz-conventional-changelog`) |

## Test discipline

The suite is large; running it indiscriminately wastes everyone's time.

- **Scoped runs are the default.** Either name the file (`pnpm vitest run test/body.test.ts`) or use `--changed` to run only tests affected by your working tree: `pnpm vitest run --changed`. Add `--changed HEAD~1` (or a branch) to cover the union since a ref.
- **Full-suite runs need a worker cap** — `pnpm test --maxWorkers=2`. CI itself runs `vitest run --maxWorkers=2`; an uncapped local run can exhaust memory the same way.
- Tests live in `test/<name>.test.ts`, one file per module, and follow the repo's assertion-chain style (`.should` on values; see `test/body.test.ts`). No `rejectedWith` — use the `rejectionOf` try/catch pattern from `test/body.test.ts`. Tests must be deterministic and isolated — no real network, no shared module-level caches across tests (use unique URLs/keys/secrets when a module caches by them).
- TypeScript in `test/` is type-checked by `pnpm typecheck` (strict + `noUncheckedIndexedAccess`), so a passing runtime run is not the whole gate — index-access and possibly-`undefined` errors surface only in `tsc`.

## Commits and releases

- **Conventional commits** — `feat:`, `fix:`, `docs:`, `perf:`, `refactor:`, `test:`, `chore:`, … `pnpm commit` walks you through it with commitizen; a hand-written `fix(adapter): …` line is equally fine. Scope is optional.
- **Releases are automated** by [semantic-release](.releaserc.json) on `main` (`.github/workflows/release.yml`): commit messages drive the version bump and the changelog. There are no manual releases, so a malformed commit type is a release-blocking mistake, not a cosmetic one.
- PR titles follow the same convention (`fix: …`, `feat: …`) — that title becomes the commit message when merged.

## The paradigm: data + functions

`src/**` must pass `pnpm check:paradigm` — no `class`, no `this`, no `new`, no `extends`. The application is plain data; every capability is a top-level function taking the app (or `ctx`) as its first argument. Practical consequences:

- **Options in, `Middleware` out.** Batteries are factories: `(options) => Middleware`. No module-level registration side effects, no classes, no `this`.
- **One file per battery.** In this repository a battery is one source file (`src/cors.ts`) wired as one build entry (`s200/cors`); it never imports the core barrel.
- **Zero runtime dependencies.** The core has none, and a battery may not add any. Use Web Standard APIs (`Request`, `Headers`, `crypto.subtle`, `CompressionStream`, `performance.now()`) or require the caller to inject the dependency (schemas, stores, clocks, sinks). The one exception in the whole tree is `s200/events` (builds on `@for-fun/event-emitter`).
- **Tree-shakable by construction.** `sideEffects: false` and named exports are the mechanism; `pnpm verify:tree-shaking` is the proof. New barrel exports must be named (`export { x } from './x'`), never `export *` — that leaks `@internal` symbols.

Writing a battery (or a middleware) end to end — gates, unwind stampers, type brands for `s200/client`, publishing — is documented in [docs/guides/battery-authoring.md](docs/guides/battery-authoring.md).

## Size budgets are an honesty gate

`pnpm size` runs size-limit over every package entry. The budgets are measurements, not targets to game:

- If your change legitimately grows an entry (new feature, more types), **run `pnpm size` and raise that entry's budget in `package.json` to the measured value** in the same PR. A few dozen bytes for a real capability is a fine trade.
- Never squeeze working code, drop types, or restructure solely to keep a number unchanged — a budget that hides the true cost is worse than no budget.
- Shared chunks can shift several entries at once; after touching anything in the shared layer, run the full `pnpm size`, not just one entry.

## Bilingual docs

- `docs/` is the **English source of truth**; `docs/zh/` mirrors it with the same path structure.
- Edit the source, never the rendered layout: `docs-site/**` contains `@include` stubs that pull the Markdown in verbatim — **do not edit `docs-site/`**; changes there are wiring, owned by the integrator.
- Code blocks are **byte-identical** between `en` and `zh`; only prose is translated. Numbers, URLs, and identifiers are exact — no reformatting in translation.
- zh headings whose text differs from the English equivalent need an explicit `{#anchor}` when other pages link to that anchor (VitePress slugifies CJK headings differently). `pnpm docs:build` dead-link checking is the final gate for both languages.
- New pages under `docs/` need a `docs-site/` stub + sidebar wiring to appear on the site — note that in your PR if you add one.

## PR checklist

Before you open the PR, from a clean working tree:

- [ ] `pnpm lint:ci` and `pnpm typecheck` pass (typecheck covers `test/` too)
- [ ] `pnpm check:paradigm` passes (any `src/` change)
- [ ] Scoped tests for the modules you touched pass: `pnpm vitest run test/<your-files>.test.ts --maxWorkers=2` (or `--changed`)
- [ ] `pnpm build` succeeds (new entries need `vite.config.mts` wiring — call that out in the PR)
- [ ] `pnpm verify:tree-shaking` passes (new modules)
- [ ] `pnpm size` run against a fresh build; budgets adjusted **upward honestly** where grown
- [ ] `pnpm attw` passes (anything touching `exports` or build output)
- [ ] Docs updated in **both** `docs/` and `docs/zh/` (code blocks byte-identical); `pnpm docs:build` passes
- [ ] Conventional-commit PR title (`feat:`, `fix:`, `docs:`, …)

Bugs and feature ideas go to [GitHub Issues](https://github.com/wmzy/s200/issues); usage questions to [GitHub Discussions](https://github.com/wmzy/s200/discussions); vulnerability reports to the [security policy](SECURITY.md) channel — never a public issue.
