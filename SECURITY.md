# Security Policy

## Reporting a vulnerability

s200 has no separate security address — please use **GitHub's private vulnerability reporting**:

1. Go to [github.com/wmzy/s200/security/advisories](https://github.com/wmzy/s200/security/advisories)
2. Click **Report a vulnerability**

Reports through this channel go privately to the maintainers. Please include the s200 version, the runtime (node / bun / Cloudflare Workers) and its version, the adapter in use (`s200/node`, `s200/bun`, edge core), and a minimal repro or proof of concept. If a specific request/response sequence matters, include the exact bytes.

Public GitHub issues are **not** the channel for unreported vulnerabilities — please do not open an issue for anything you believe is exploitable until the advisory is published.

## Scope

In scope:

- The framework source in `src/` — core, router, adapters (`s200/node`, `s200/bun`, `s200/cloudflare`), and every official battery (cors, auth, cookies/sessions, rate-limit, body parsing, upload, websocket, …).
- The official recipes in [`recipes/`](recipes/) (e.g. `redis-stores.ts`, `oidc.ts`).
- The published package artifacts and package entry points.

Out of scope:

- Applications **built with** s200 — their own handler logic, their dependency choices, and their deployment configuration are the application's surface, not the framework's.
- The scaffolding output of `create-s200` once generated (report generator bugs in [create-s200](https://github.com/wmzy/create-s200) — but generated app code is the user's).
- Denial-of-service by flooding any legitimately listening server, and findings that require already-full compromise of the host.

## Supported versions

s200 is pre-1.0: only the latest release on the `main` line receives security fixes. There are no backport branches; a fix lands on `main` and ships in the next release.

## What to expect

- **Acknowledgment** of a private report within 7 days.
- An initial assessment — accepted, declined, or needs-more-info — within 14 days of acknowledgment.
- Fixes for accepted vulnerabilities ship in a patch or minor release, timed with the reporter where coordinated disclosure makes sense. Credit is given in the release notes unless you prefer to remain anonymous.
