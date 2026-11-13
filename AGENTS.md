# Agent instructions

This repository is an intentionally empty TypeScript project on Bun and Effect. It is a foundation for a new project, not a sample application. Add only the source the project needs under the workspace that owns it (`apps/*`, `packages/*`, `infra`); do not pre-create shared modules, packages, or example code.

## Policy

`vite.config.ts` (formatting, lint, tests), `tsconfig.json` (types), and `tools/lint/` (repository rules) are the source of truth.

- Fix code instead of weakening policy. Do not turn off rules, add broad disable comments, or skip checks without explicit approval.
- Use Effect error channels; built-in try/catch is prohibited by lint.
- Name files and directories in kebab-case. `unicorn/filename-case` and `workspace/kebab-case-paths` enforce it.
- Do not add function-decomposition, type-design, or require-doc-comment lint policies.
- Preserve the pinned dependency versions. Add a dependency only with a stated reason; a library that `docs/capabilities.md` lists needs only the name of its registry row.
- Before writing code, walk the ladder: a Cloudflare platform capability, then an Alchemy resource or binding, then an Effect module, service or layer, then an installed dependency or the stack's standard library (check `docs/capabilities.md`), then code in this repository, and only then an external service.

If a rule appears inappropriate, explain the failing rule, why changing the code would be worse, the smallest policy change, and its consequences. Change the policy only after approval.

## Workflow

Run `bun run check`, then `bun run test`, before completing implementation. `bun run test` runs `bun test .test.mjs` only for the Node-loaded lint-rule suites, then `vp test` (Vitest with `@effect/vitest`) for project tests: every `*.test.ts` file, including those under `tools/lint/` except `tools/lint/fixtures/**`, under a workspace's `src/`, the root `test/` or `tools/`, using `it.effect` for effectful cases. Keep focused tests beside their implementation and cross-module tests in `test/`. Delete `passWithNoTests` from `vite.config.ts` once the first test exists.

A worktree runs its own `bun install` before any package script, binary or patch tool (`typescript` and `@effect/tsgo` included), because package resolution walks up into the main checkout.

A pre-push hook (`.vite-hooks/pre-push`, installed by `bun install`) runs the same checks and blocks the push if any fail. Fix the problems rather than bypassing it with `--no-verify` or `VP_GIT_HOOKS=0`.

## Effect-native source and tests

All source and tests are Effect-native (operator ruling). No `throw`, `try/catch`, raw Promise chains, `Promise.allSettled`, `fetch`, `node:` imports or `Bun.` file calls in source; no new `bun:test` files. Use Schema to decode files, environment values and payloads, Config for settings, and `@effect/platform-bun` for the file system and HTTP. A suite that genuinely cannot load Effect (a Node-loaded `.mjs` lint plugin) may stay on `bun:test` with a one-line comment naming why.

```ts
// Typed error in the error channel
class PinError extends Schema.TaggedError<PinError>()("PinError", { message: Schema.String }) {}
```

```ts
// File system read through the platform service
const text = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString("supdoc.lock");
}).pipe(Effect.provide(BunFileSystem.layer));
```

```ts
// Test with @effect/vitest
it.effect("rejects a text with no tag line", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parsePin("x"));
    expect(error._tag).toBe("PinError");
  }),
);
```

## Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its relevant links. For APIs not covered there, consult `node_modules/effect/src` matching the installed version.

Use Effect `Config` for environment-backed settings. Define decoding, constraints, optional values, and missing-value defaults in Config and Schema; invalid supplied values fail through the Effect error channel. Parse at the owning runtime boundary and test with `ConfigProvider.fromUnknown` rather than mutating the host environment.

## Upstream source

Installed packages carry their source: read `node_modules/<package>/src` and `node_modules/effect/AGENTS.md` first. For upstream docs, examples and source that npm does not ship (Alchemy, Better Auth, Drizzle, TanStack), run `bun run mirrors` once (47 MB on disk), then read `.mirrors/INDEX.md`.

## Schema intent

Data models shape the rest of the project. Before changing a schema, establish the expected domain meaning, data preservation requirements, and compatibility preferences from the user's instructions and current project context. If those expectations are unclear, check with the user before making consequential assumptions. Do not ask again when the relevant expectation is already settled.

Do not introduce nullable fields, legacy repair paths, transitional models, or compatibility layers merely because earlier iterations used a different shape. Nullability must represent an actual optional value; backwards compatibility must serve an established requirement.

## Skills

- [.agents/skills/add-block/SKILL.md](.agents/skills/add-block/SKILL.md): adding a removable block, attaching it to core, and checking it with `bun run footprint` and `bun run pullout`.
- [.agents/skills/add-feature/SKILL.md](.agents/skills/add-feature/SKILL.md): adding a feature slice that declares no resource and adds no Worker.
- [.agents/skills/conventional-commits/SKILL.md](.agents/skills/conventional-commits/SKILL.md): commit boundaries, staging, and messages.
- [.agents/skills/document-code/SKILL.md](.agents/skills/document-code/SKILL.md): JSDoc for every program unit and the constraints it must preserve.
- [.agents/skills/effect-design/SKILL.md](.agents/skills/effect-design/SKILL.md): the native-capability review and local Effect rulings.
- [.agents/skills/error-messages/SKILL.md](.agents/skills/error-messages/SKILL.md): caller-facing and developer-facing errors.
- [.agents/skills/shadcn/SKILL.md](.agents/skills/shadcn/SKILL.md): the official shadcn skill for `packages/ui`. Patched from upstream in two places: its load-time command and `allowed-tools` use the pinned runner `bun run ui` (shadcn 4.23.0) instead of `@latest`, and the "check community registries" sentence is removed because the repository uses the stock registry only.
- [.agents/skills/supdoc/SKILL.md](.agents/skills/supdoc/SKILL.md): keeping linked docs in step with the code they point at.
- [.agents/skills/trace-effect/SKILL.md](.agents/skills/trace-effect/SKILL.md): spans and logs for effectful operations.
- [.agents/skills/work-with-stacks/SKILL.md](.agents/skills/work-with-stacks/SKILL.md): deploying and destroying stages on local state, the orphan count, and what never runs from a laptop.
- [.agents/skills/write-migration/SKILL.md](.agents/skills/write-migration/SKILL.md): changing a schema and generating its D1 migration safely, and what `bun run db:check` refuses.

A skill edit reruns `./node_modules/.bin/supdoc update` and commits the changed `supdoc.lock` entries. A supdoc bump runs `./node_modules/.bin/supdoc skill install --yes`, then `./node_modules/.bin/supdoc update`.

Keep only broadly reusable foundation skills here. Project-specific skills belong in the project that needs them.
