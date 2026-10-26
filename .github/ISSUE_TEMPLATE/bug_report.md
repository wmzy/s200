---
name: Bug report
about: Something in s200 does not behave as documented or expected
title: '[bug] '
labels: bug
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to report a bug. Before opening an issue,
        please [search Discussions](https://github.com/wmzy/s200/discussions) —
        usage questions and misconfigurations are often answered there already.
        If you are unsure whether this is a bug, a Discussion is the faster path.
  - type: input
    id: runtime
    attributes:
      label: Runtime and version
      description: Which runtime serves the app, and its exact version (`node --version` / `bun --version`).
      placeholder: node v22.14.0 (also happens on bun 1.2.10)
    validations:
      required: true
  - type: input
    id: s200-version
    attributes:
      label: s200 version
      description: The version from your lockfile (`pnpm why s200` / `npm ls s200`).
      placeholder: s200@0.x.y
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      description: Minimal, self-contained reproduction — a snippet that can be pasted and run. Include how the app is served (`s200/node`, `s200/bun`, cloudflare, …).
      placeholder: |
        1. `pnpm add s200`
        2. Run this snippet:
           ```ts
           ...
           ```
        3. `curl localhost:3000/...`
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
      description: What you expected to happen, citing the doc page or section if the behavior contradicts documentation.
    validations:
      required: true
  - type: textarea
    id: actual
    attributes:
      label: Actual behavior
      description: What actually happened — status code, body, stack trace, logs. Verbatim output beats paraphrase.
    validations:
      required: true
