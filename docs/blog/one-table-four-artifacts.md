# One route table, four artifacts

Somewhere between "write the routes" and "run the fleet", every API
project grows a second job: keeping the API's *description* — the docs,
the client, the gateway config — synchronized with the API itself.
Most frameworks treat each of those as a separate integration with its
own source of truth. s200's [`data + functions`](/comparison) core
makes a different bet: if the app is plain data, then every artifact
derived from it can be a pure function, and drift stops being a process
problem and becomes a non-event. This piece walks the same route table
through four artifacts — a JSON export, an OpenAPI 3.1 document, a
standalone typed client, and nginx/Kubernetes Gateway API config — and
shows what purity buys at each step.

## The table itself

The starting point is not a DSL and not a decorator pass; it is the
app's own route table, exportable without executing anything:

```ts
import { createApp, get, post } from 's200';
import { describeApp, describeRoute } from 's200/meta';
import { createRouteTable, formatRouteTable } from 's200/route-table';

const app = createApp();
get(app, '/users/:id', (ctx) => { /* … */ });
post(app, '/users', (ctx) => { /* … */ });
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: {
    200: { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  },
});

const table = createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 0 }, …] }
```

`createRouteTable` produces JSON-compatible data — method, pattern,
param names, middleware counts (functions themselves are not
serializable, so only the count travels). `formatRouteTable` renders it
as aligned ASCII, which is exactly what the `s200 routes` command and
the dev runner's startup report print. Already useful; the interesting
consumers come next.

## Artifact one: the OpenAPI 3.1 document

```ts
import { openapiJson, openapiSpec } from 's200/openapi';

get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
const spec = openapiSpec(app);                               // or hold it as data
```

`openapiSpec` walks the table and the annotations together: every route
becomes a path item, `SerializeSchema` shapes convert to JSON Schema,
schemas occurring two or more times are deduplicated into
`components.schemas`, `throws` gates surface as error responses, and
`meta.security` lands on operations verbatim. No code generation, no
execution, no schema library — the emitter is a pure function of the
table plus its metadata. `describeApp` supplies the `info` block, so
even the document's title comes from data.

Because the document is derived, not authored, it cannot disagree with
the routes — a pattern registered but not annotated still appears (with
its params and a bare 200), and a typo'd pattern simply is not in the
document. The spec is the contract; the [tooling
page](/api/openapi) covers what plugs into it (Scalar docs UI via
`s200/swagger`, typed clients for any language via the OpenAPI
toolchain).

## Artifact two: the typed client, as source

The same walk can emit TypeScript instead of JSON:

```ts
import { generateClient } from 's200/codegen';
import { writeFile } from 'node:fs/promises';

await writeFile(
  'src/api/client.ts',
  generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' })
);
```

`s200/codegen`'s `generateClient` returns the source of a
self-contained client module: params typed from each pattern
(`/users/:id` → `args: { id: string }`), `init.query` from the query
annotations, `init.body` from the body annotation (the route reads a
body, the caller must send one), and a **status-discriminated response
union** from `meta.responses` merged with `throws` gates — narrowing
`res.status` narrows `res.json()`. The emitted file has **zero s200
imports**: path filling, query-string and JSON-body logic are emitted
inline, so it runs anywhere web fetch runs, with no s200 in
`node_modules` — hand the file to another team or another repo.

The honest contract travels with it: handler body brands are
compile-time phantoms the runtime table cannot see, so anything neither
`meta` nor `throws` declares types `unknown`. And the output is
deterministic — registration order, no timestamps — so the generated
client diffs and commits like hand-written source. That property is not
an accident; it is what makes codegen safe to run in CI, and it comes
from the same place everything else here does: a pure function over
ordered data.

## Artifact three: gateway config

The last artifact answers a different question — not "what does the API
look like" but "how does traffic reach it". `s200/shard`'s
`shardSpecs(app, groups)` resolves shard-group declarations against the
actual route table into plain `ShardSpec` data; `s200/gateway` compiles
that data into the config surfaces a fleet actually runs:

```ts
import { policy, shardSpecs } from 's200/shard';
import { nginxConf, gatewayRoutes, albRules } from 's200/gateway';

policy(app, 'GET', '/admin/:path*', { timeoutMs: 30_000, streaming: true });
const specs = shardSpecs(app, [
  { id: 'api', prefix: '/api', policy: { timeoutMs: 5_000 } },
  { id: 'admin', prefix: '/admin', entry: './shards/admin.ts' },
  { id: 'main', prefix: '/' },
]);

const nginx = nginxConf(specs, { socketDir: '/run/s200' });   // upstreams + location ^~ blocks
const k8s = gatewayRoutes(specs, { hostname: 'api.example' }); // one Gateway API HTTPRoute, YAML
const alb = albRules(specs, { targetGroupArns: { /* shard id → ARN, every shard needs one */ } });
```

Three deploy targets, one routing truth: the nginx view emits `upstream`
blocks plus `location ^~ <prefix>` server blocks; the Gateway API view
emits a Kubernetes `HTTPRoute` manifest; the AWS view emits ALB listener
rules as JSON. Prefixes render literally in every view — nginx `^~`,
Gateway API `PathPrefix`, ALB `path-pattern` — and regex locations are
never emitted, because shard prefixes are plain path data. Rules are
sorted longest-prefix-first (Gateway API evaluates top-down, ALB by
ascending priority), and a prefix without a leading `/` throws at
generation, not at apply.

Every generator is a pure string function — same specs in,
byte-for-byte same string out, no I/O — so the output is
golden-testable and safe to hand to config management or diff in CI.
Add a route, move a prefix, change a policy: the regenerated config is
the reviewable diff. `matchShard(specs, pathname)` — the longest-prefix
dispatch the gateway config encodes — is the same seam the dev
dispatcher and any custom router share, so "what nginx will do" and
"what the dispatcher does" cannot fork either. The full surface is in
the [sharding reference](/api/sharding).

## What purity buys

The four artifacts have one shape in common: each is a deterministic
function of plain data — no execution, no side effects, no framework
runtime required to produce them. That single property is what pays for
everything above:

- **CI-diffability.** Deterministic output means generated artifacts
  review like source. A changed client or gateway config is a diff, not
  a leap of faith.
- **No drift, by construction.** The spec, the client, and the gateway
  config all read the same table. There is no second description to
  forget to update, because there is no second description.
- **Portability.** The OpenAPI document works with the whole 3.1
  toolchain (typed clients for any language, Scalar, generators); the
  emitted client module needs nothing but fetch; the gateway configs
  work with the infrastructure you already run.
- **Testability.** Pure functions are golden-testable — pin the exact
  bytes in a snapshot, and any change to routes, annotations, or shard
  groups shows up as an explicit, reviewable delta.

None of this required a plugin system, a build hook, or a reflection
API — just the discipline of keeping the app data and deriving
everything else. The [package surface](/guides/package-surface) lists
every entry point; the walk through the OpenAPI side lives in
[OpenAPI & tooling](/api/openapi), the shard and gateway side in
[sharding](/api/sharding).
