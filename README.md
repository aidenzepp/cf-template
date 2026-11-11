# cf-template

A Cloudflare project template: three Workers (`web`, `api`, `auth`) over service bindings, Better Auth, Drizzle on D1 and TanStack Start, deployed by Alchemy. `web` is the only public door.

The toolchain is pinned (Bun, Effect, TypeScript 7, Vite+ with Ultracite's Oxlint presets), every push is checked locally and in CI, and the repository carries the agent skills the project builds with.

## Start a project

```console
$ gh repo create my-project --template aidenzepp/cf-template --private --clone
$ cd my-project
$ bun install
```

Follow `docs/spin-up.md`; `bun install` also installs the hooks.

## What it includes

| Path                   | Does                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `docs/architecture.md` | The design: scope, request path, stages, platform operations and the build plan   |
| `docs/spin-up.md`      | The spin-up runbook, each step tagged `verified`, `unproven` or `note`            |
| `vite.config.ts`       | Formatting, Oxlint with the Ultracite core and anti-slop presets, and Vitest      |
| `tools/`               | Repository checks, lint rules and the runbook check                               |
| `.vite-hooks/pre-push` | Runs `check` and `test` before every push                                         |
| `.github/workflows/`   | CI on pushes to `main` and on pull requests                                       |
| `AGENTS.md`            | Where agents start: policy, workflow and the skills to load                       |
| `.agents/skills/`      | The skills agents load for commits, docs, Effect design, errors, tracing and more |

## Verify

```bash
bun run check
bun run test
```

`check` runs formatting, lint, type checks and the runbook check with warnings treated as errors. `test` runs the lint-rule tests, then the project's Vitest suite.

## Editor

No editor settings are committed. For VS Code set `"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "./node_modules/typescript/bin"` so the editor uses the repository's `typescript` and the Effect language service rather than the bundled compiler.
