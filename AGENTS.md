# Agent instructions

This repository is an intentionally empty TypeScript project on Bun and Effect. It is a foundation for a new project, not a sample application. Add only the source the project needs under `src/`; do not pre-create shared modules, packages, or example code.

## Policy

`vite.config.ts` (formatting, lint, tests), `tsconfig.json` (types), and `tools/lint/` (repository rules) are the source of truth.

- Fix code instead of weakening policy. Do not turn off rules, add broad disable comments, or skip checks without explicit approval.
- Use Effect error channels; built-in try/catch is prohibited by lint.
- Name files and directories in kebab-case. `unicorn/filename-case` and `workspace/kebab-case-paths` enforce it.
- Do not add function-decomposition, type-design, or require-doc-comment lint policies.
- Preserve the pinned dependency versions. Add a dependency only with a stated reason.

If a rule appears inappropriate, explain the failing rule, why changing the code would be worse, the smallest policy change, and its consequences. Change the policy only after approval.

## Workflow

Run `bun run check`, then `bun run test`, before completing implementation. `bun run test` runs `bun test tools` for the lint-rule suites, then `vp test` (Vitest with `@effect/vitest`) for project tests: `*.test.ts` files under `src/` or `test/`, using `it.effect` for effectful cases. Keep focused tests beside their implementation and cross-module tests in `test/`. Delete `passWithNoTests` from `vite.config.ts` once the first test exists.

A pre-push hook (`.vite-hooks/pre-push`, installed by `bun install`) runs the same checks and blocks the push if any fail. Fix the problems rather than bypassing it with `--no-verify` or `VP_GIT_HOOKS=0`.

## Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its relevant links. For APIs not covered there, consult `node_modules/effect/src` matching the installed version.

Use Effect `Config` for environment-backed settings. Define decoding, constraints, optional values, and missing-value defaults in Config and Schema; invalid supplied values fail through the Effect error channel. Parse at the owning runtime boundary and test with `ConfigProvider.fromUnknown` rather than mutating the host environment.

## Schema intent

Data models shape the rest of the project. Before changing a schema, establish the expected domain meaning, data preservation requirements, and compatibility preferences from the user's instructions and current project context. If those expectations are unclear, check with the user before making consequential assumptions. Do not ask again when the relevant expectation is already settled.

Do not introduce nullable fields, legacy repair paths, transitional models, or compatibility layers merely because earlier iterations used a different shape. Nullability must represent an actual optional value; backwards compatibility must serve an established requirement.

## Skills

- `.agents/skills/conventional-commits`: commit boundaries, staging, and messages.
- `.agents/skills/document-code`: JSDoc for every program unit and the constraints it must preserve.
- `.agents/skills/effect-design`: the native-capability review and local Effect rulings.
- `.agents/skills/error-messages`: caller-facing and developer-facing errors.
- `.agents/skills/trace-effect`: spans and logs for effectful operations.

Keep only broadly reusable foundation skills here. Project-specific skills belong in the project that needs them.
