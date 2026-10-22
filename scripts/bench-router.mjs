// Router micro-benchmark: dispatch cost across the route table, run
// against the built dist so numbers reflect the shipped artifact.
//
//   pnpm bench                     # default shape: 200 static-prefixed routes
//   ROUTES=2000 ITERATIONS=50000 pnpm bench
//
// Scenarios:
//   - first hit   best case (index finds the bucket immediately)
//   - last hit    worst case within one static bucket
//   - miss        no static bucket at all — pure dynamic scan
//   - param-first every route shares a ':x' first segment (full root scan)
//   - multi hit   the same paths registered for GET, POST and PUT — the
//                 shape that exposes a router paying for the methods it
//                 cannot serve (the single-method shapes above cannot)
//   - multi 405   the 405 path of that table (no method matches)
import { createRoute, matchRoutes } from '../dist/index.mjs';

const ROUTES = Number(process.env.ROUTES ?? 200);
const ITERATIONS = Number(process.env.ITERATIONS ?? 100_000);

const routes = [];
for (let i = 0; i < ROUTES; i += 1) {
  routes.push(createRoute('GET', `/api/resource${i}/:id/:slug`, () => undefined));
}

const paramFirst = [];
for (let i = 0; i < ROUTES; i += 1) {
  paramFirst.push(createRoute('GET', `/:tenant/resource${i}`, () => undefined));
}

// The same paths, three methods each: a router that matches the path of
// every method-incompatible candidate pays for the extra methods on every
// request, so this table's cost must stay close to the single-method one.
const multi = [];
for (let i = 0; i < ROUTES; i += 1) {
  for (const method of ['GET', 'POST', 'PUT']) {
    multi.push(createRoute(method, `/api/resource${i}/:id/:slug`, () => undefined));
  }
}

function bench(name, table, pathname, method = 'GET') {
  let hits = 0;
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) {
    if (matchRoutes(table, method, pathname) !== undefined) hits += 1;
  }
  const ms = performance.now() - t0;
  return { name, 'µs/req': +((ms * 1000) / ITERATIONS).toFixed(2), hits };
}

const rows = [
  bench('first hit   ', routes, '/api/resource0/1/a'),
  bench('last hit    ', routes, `/api/resource${ROUTES - 1}/42/hello`),
  bench('miss        ', routes, '/nope/nope'),
  bench('param-first ', paramFirst, `/:x/resource${ROUTES - 1}`),
  bench('multi hit   ', multi, '/api/resource0/1/a'),
  bench('multi 405   ', multi, '/api/resource0/1/a', 'DELETE'),
];
const [first] = rows;
console.log(`routes=${ROUTES} iterations=${ITERATIONS}`);
for (const row of rows) {
  console.log(
    `${row.name} ${String(row['µs/req']).padStart(8)} µs/req   x${(row['µs/req'] / first['µs/req']).toFixed(1)}   (hits=${row.hits})`
  );
}
