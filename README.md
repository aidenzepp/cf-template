# typescript-template

An intentionally empty Bun, Effect and TypeScript project with shared lint policy and guidance for agents.

It pins the toolchain (Bun 1.4.3, Effect 4.1.2, TypeScript 7, Vite+ with Ultracite's Oxlint presets), checks every push locally and in CI, and carries the agent skills shared across these projects. It ships no source, build step or release setup. For a Cloudflare app, start from [cloudflare-monorepo-template](https://github.com/aidenzepp/cloudflare-monorepo-template) instead.

## Start a project

```console
$ gh repo create my-project --template aidenzepp/typescript-template --private --clone
$ cd my-project
$ bun install
```

Rename `name` in `package.json`, then add the project's code under `src/`. `bun install` also installs the pre-push hook.

## What it includes

| Path                       | Does                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `vite.config.ts`           | Formatting, Oxlint with the Ultracite core and anti-slop presets, type-aware checks, and Vitest |
| `tools/lint/`              | Repository lint rules: no built-in `try`/`catch`, kebab-case directories                        |
| `.vite-hooks/pre-push`     | Runs `check` and `test` before every push                                                       |
| `.github/workflows/ci.yml` | Runs the same checks on pushes to `main` and on pull requests                                   |
| `AGENTS.md`                | Where agents start: policy, workflow and the skills to load                                     |
| `.agents/skills/`          | `conventional-commits`, `document-code`, `effect-design`, `error-messages`, `trace-effect`      |

## Verify

```bash
bun run check
bun run test
```

`check` runs formatting, lint and type checks with warnings treated as errors. `test` runs the lint-rule tests, then the project's Vitest suite, which passes while it is empty. Delete `passWithNoTests` from `vite.config.ts` once the first test exists.
