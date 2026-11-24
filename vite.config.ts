import { readdirSync } from "node:fs";
import { recommended as effect } from "@effect/tsgo/oxlint-presets";

import { defineConfig } from "vite-plus";

import core from "ultracite/oxlint/core";

import antiSlop from "ultracite/oxlint/anti-slop";

import drizzle from "ultracite/oxlint/drizzle";

import shadcn from "ultracite/oxlint/shadcn";

import { importRestrictionOverrides } from "./tools/lint/overrides/import-restrictions.ts";

import { ruleScopeOverrides } from "./tools/lint/overrides/rule-scopes.ts";

import { dataAccessMembers, runMembers } from "./tools/lint/rules/restricted-properties.ts";

/**
 * Matches module declarations and calls without spacing local call groups.
 */
const topLevelUnit = {
  selector:
    'Program > :matches(ExportNamedDeclaration, ExportDefaultDeclaration, FunctionDeclaration, ClassDeclaration, TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration, TSModuleDeclaration, VariableDeclaration, ExpressionStatement[expression.type="CallExpression"])',
};

/**
 * Matches direct and yielded Effect logs, including piped log annotations.
 */
const effectLogStatement = {
  selector:
    'ExpressionStatement:matches([expression.type="CallExpression"], [expression.type="YieldExpression"]):has(CallExpression[callee.type="MemberExpression"][callee.object.name="Effect"][callee.property.name=/^log(Trace|Debug|Info|Warning|Error|Fatal)?$/])',
};

/**
 * The registry-owned tree of `packages/ui`, written only by the shadcn CLI. Policy change required
 * by `AGENTS.md`:
 *
 * - Failing rules: 555 lint diagnostics and 26 format failures without this ignore.
 * - Why changing the code is worse: vendored code is never edited, so no finding there could ever be
 *   fixed.
 * - Smallest change: ignore only the registry-owned tree and `components.json`; the hand-authored
 *   `packages/ui/package.json` and `tsconfig.json` stay formatted and linted.
 * - Consequence: no lint or format on those paths; the type check moves to the `packages/ui` script
 *   run by `bun run check`.
 */
const vendored = ["packages/ui/src/**", "packages/ui/components.json"];

/**
 * A committed `.only` would silently skip every other test in its file; Vitest defaults `allowOnly`
 * to on outside CI, so each project turns it off and a focused test fails the run everywhere.
 */
const noOnly = { allowOnly: false };

/**
 * One Vitest project per directory under `packages/`, named after the directory, so adding or
 * removing a package needs no edit here (#232). `ui` is left out: it is the shadcn registry tree
 * (`vendored`), holds no tests, and is type-checked by its own script.
 */
const packageProjects = readdirSync(new URL("packages", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "ui")
  .map((entry) => entry.name)
  .map((name) => ({ test: { ...noOnly, include: [`packages/${name}/src/**/*.test.ts`], name } }));

/**
 * Every Vitest project, in the order `vp test` lists them. The `ci-test-*` tasks below derive one
 * task per name, so a project added here gets its own cached task.
 */
const testProjects = [
  {
    test: {
      ...noOnly,
      exclude: ["tools/lint/fixtures/**", "tools/ratchet/fixtures/**"],
      globalSetup: ["tools/db/global-setup.ts"],
      include: ["tools/**/*.test.ts"],
      name: "tools",
    },
  },
  {
    test: {
      ...noOnly,
      exclude: ["test/local/**"],
      include: ["test/**/*.test.ts"],
      name: "root",
    },
  },
  { test: { ...noOnly, include: ["apps/web/src/**/*.test.ts"], name: "web" } },
  { test: { ...noOnly, include: ["apps/api/src/**/*.test.ts"], name: "api" } },
  { test: { ...noOnly, include: ["apps/auth/src/**/*.test.ts"], name: "auth" } },
  ...packageProjects,
  { test: { ...noOnly, include: ["infra/**/*.test.ts"], name: "infra" } },
  {
    test: {
      ...noOnly,
      include: ["test/local/**/*.test.ts"],
      name: "local",
      setupFiles: ["test/local/setup.ts"],
    },
  },
  { test: { ...noOnly, include: ["test/e2e/**/*.e2e.ts"], name: "e2e-local" } },
];

/**
 * The inputs every `ci-*` task shares. `work/` is agent scratch (`tools/db/check.ts` leaves a
 * `db-check-auth-schema-*` directory there on every run) and `.worktrees/` holds sibling checkouts;
 * both are gitignored and no task reads them, but a task that lists the repository root would miss
 * the cache whenever either one changes. `.tanstack` is the gitignored route-tree output that the
 * `web` tests write, and it would flip every task that lists `apps/web` on the next run. `dist` is
 * the `apps/web` build output: a task that lists `apps/web` before the build exists would miss once
 * the build has run.
 */
const sharedInput = [{ auto: true }, "!work/**", "!.worktrees/**", "!**/.tanstack/**"];

/**
 * The cache settings of a `ci-*` task that does not read build output. `output: []` stops a cache
 * hit from restoring files a task wrote as a side effect.
 */
const ciCache = { input: [...sharedInput, "!**/dist", "!**/dist/**"], output: [] };

/**
 * One cached `vp run` task per project that `bun run test` runs; `e2e-local` is the one it
 * excludes. `vp run` sets `FORCE_COLOR=1` on a task, and the native `tsc` that
 * `tools/lint/fixtures.test.ts` spawns colors its output whenever `FORCE_COLOR` is present,
 * whatever its value, so that assertion fails; `NO_COLOR=1` outranks it.
 * `apps/web/src/ratelimit.harness.test.ts` splits stderr on a plain message and fails under color
 * codes the same way.
 */
const testTasks = Object.fromEntries(
  testProjects.flatMap(({ test: { name } }) =>
    name === "e2e-local"
      ? []
      : [[`ci-test-${name}`, { cache: ciCache, command: `NO_COLOR=1 vp test --project ${name}` }]],
  ),
);

/**
 * Every `ci-*` task that `vp run ci` waits on.
 */
const ciTaskNames = [
  ...Object.keys(testTasks),
  "ci-bundle-check",
  "ci-db-check",
  "ci-design-lint",
  "ci-fmt",
  "ci-hooks-present",
  "ci-knip",
  "ci-lint",
  "ci-ratchet",
  "ci-runbook",
  "ci-supdoc",
  "ci-test-bun-mjs",
  "ci-typecheck",
  "ci-ui-typecheck",
];

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".agents/**",
      ".mirrors/**",
      ".worktrees/**",
      "**/*.gen.ts",
      "apps/auth/src/db/schema.ts",
      "**/migrations/**",
      "bun.lock",
      // release-please writes CHANGELOG.md in its own style on every release PR (#383).
      "CHANGELOG.md",
      "oxlint-suppressions.json",
      "tools/lint/fixtures/**",
      "tools/ratchet/fixtures/**",
      "work/**",
      ...vendored,
    ],
    jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
  },
  lint: {
    // `drizzle` is adopted although it has no oxlint rules today, so a later Drizzle rule arrives
    // with the preset. `react` and `vitest` are scoped in `overrides` below. `tanstack` is not
    // adopted: it turns `sort-keys` off for the whole repository and the kebab-case filename rule
    // off under `routes/`; two of its decisions are copied as scoped overrides instead. `effect` is
    // the `@effect/tsgo` Effect rule set: it runs in this one `vp check` pass only while
    // `effect-tsgo patch --oxlint --tsrs` has patched the toolchain, and the canary test turns red if not.
    // Not adopted from the Cloudflare Oxlint preset (#437): `import/no-namespace`, which Ultracite core
    // also leaves off. Effect is imported by name; the one `effect/Effect` namespace import is a test
    // that lists the module's exports. The 67 findings at adoption were `import * as` from `alchemy` and
    // `@alchemy.run/*` (54, Alchemy's documented style), `@distilled.cloud/cloudflare/*` (9), the local
    // Drizzle schema handed to the Better Auth adapter (2), `@effect/sql-d1/D1Client` (1) and
    // `effect/Effect` (1).
    // Adopted from the Cloudflare Oxlint preset (#437): no whole category is on by default, so an
    // Oxlint upgrade cannot switch on a rule unseen. The presets and this file already list every rule
    // that runs: `vp lint --print-config` and the enabled-rule count (1384) are the same either way.
    categories: { correctness: "off" },
    extends: [core, antiSlop, shadcn, drizzle, effect],
    ignorePatterns: [
      ".agents/**",
      ".mirrors/**",
      ".worktrees/**",
      "**/*.gen.ts",
      "apps/auth/src/db/schema.ts",
      "**/migrations/**",
      "dist/**",
      "tools/lint/fixtures/**",
      "tools/ratchet/fixtures/**",
      "work/**",
      ...vendored,
    ],
    jsPlugins: [
      "./tools/lint/plugin.mjs",
      "@stylistic/eslint-plugin",
      // Landmines 0.3.0, registered for its rule lines below; the Ultracite 8.3 `landmines` preset
      // targets the 0.1.x subpaths that 0.2.0 removed, so it is not used.
      { name: "landmines", specifier: "@interfere/landmines" },
      // The plugin carries no name of its own; the Cloudflare preset registers it as `@nkzw` too.
      { name: "@nkzw", specifier: "@nkzw/eslint-plugin" },
      ...shadcn.jsPlugins,
    ],
    // `vp check` runs type-aware rules and the type check only when both are enabled.
    // https://viteplus.dev/guide/check
    options: { reportUnusedDisableDirectives: "error", typeAware: true, typeCheck: true },
    overrides: [
      {
        // Build and stack configuration reads its host's process.env; Effect Config applies at runtime boundaries.
        files: [
          "**/vite.config.ts",
          "infra/alchemy.run.ts",
          "infra/stacks/*.ts",
          "infra/src/**/*.ts",
        ],
        rules: { "effecttsgo/process-env": "off" },
      },
      ...importRestrictionOverrides,
      ...ruleScopeOverrides,
    ],
    rules: {
      // Adopted from the Cloudflare Oxlint preset (#437), which takes both from `@nkzw/oxlint-config`.
      // `instanceof` breaks across realms and bundled copies of a class; a tagged error is told apart
      // by `_tag` and a Schema by `Schema.is`.
      "@nkzw/no-instanceof": "error",
      // A hook-style `use*` call with an Effect dependency array must name its dependencies.
      "@nkzw/require-use-effect-arguments": "error",
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", next: topLevelUnit, prev: "*" },
        { blankLine: "always", next: "*", prev: topLevelUnit },
        {
          blankLine: "always",
          next: "const",
          // Effect generator calls are wrapped in yield expressions.
          prev: {
            selector:
              'ExpressionStatement:matches([expression.type="CallExpression"], [expression.type="YieldExpression"][expression.argument.type="CallExpression"])',
          },
        },
        { blankLine: "always", next: "return", prev: "*" },
        { blankLine: "always", next: "*", prev: "if" },
        { blankLine: "always", next: "*", prev: effectLogStatement },
        // Ported from `anti-slop/require-readable-spacing` (issue #11 item 12).
        { blankLine: "always", next: "*", prev: "import" },
        { blankLine: "always", next: ["function", "class", "interface", "type"], prev: "*" },
        { blankLine: "always", next: "*", prev: ["function", "class", "interface", "type"] },
        {
          blankLine: "always",
          next: ["multiline-const", "multiline-let", "multiline-var", "multiline-using"],
          prev: "*",
        },
        {
          blankLine: "always",
          next: "*",
          prev: ["multiline-const", "multiline-let", "multiline-var", "multiline-using"],
        },
        {
          blankLine: "always",
          next: ["return", "if", "switch", "try", "for", "while", "do"],
          prev: "*",
        },
        { blankLine: "always", next: "*", prev: "block-like" },
        // The exceptions `require-readable-spacing` carries; the last matching entry wins.
        { blankLine: "any", next: "import", prev: "import" },
        {
          blankLine: "any",
          next: {
            selector:
              ':matches(TSDeclareFunction, FunctionDeclaration, ExportNamedDeclaration[declaration.type="TSDeclareFunction"], ExportNamedDeclaration[declaration.type="FunctionDeclaration"])',
          },
          prev: {
            selector:
              ':matches(TSDeclareFunction, ExportNamedDeclaration[declaration.type="TSDeclareFunction"])',
          },
        },
      ],
      // One source for the blank-line policy: the fixture diff in tools/lint/fixtures.test.ts
      // (blank-lines/cases.ts) shows the stylistic padding rule above reports every line this rule does.
      "anti-slop/require-readable-spacing": "off",
      // The seven deltas on the `effect` preset: `try-catch-in-effect-gen` off (a true subset of
      // `workspace/no-built-in-try-catch`); `any-unknown-in-error-context`, `effect-try-without-catch`,
      // `unsafe-effect-type-assertion`, `process-env-in-effect`, `extends-native-error` and
      // `process-env` at `warn`. No rule is staged off: every family #223 split them into is on.
      "effecttsgo/any-unknown-in-error-context": "warn",
      "effecttsgo/effect-try-without-catch": "warn",
      "effecttsgo/extends-native-error": "warn",
      "effecttsgo/process-env": "warn",
      "effecttsgo/process-env-in-effect": "warn",
      "effecttsgo/try-catch-in-effect-gen": "off",
      "effecttsgo/unsafe-effect-type-assertion": "warn",
      // Adopted from the Cloudflare Oxlint preset (#437); the repository had no finding at adoption.
      // Reports a duplicate export name, which a bundler resolves silently.
      "import/export": "error",
      // Landmines 0.3.0 (#434), every rule listed. A rule that is on reports nothing today. A rule
      // that is off carries its reason and the findings measured on the tree when it was left off.
      "landmines/colocated-tests": "error",
      "landmines/declared-test-inputs": "error",
      "landmines/max-exports-per-module": "error",
      "landmines/max-file-lines": "error",
      "landmines/max-files-per-directory": "error",
      "landmines/no-clipboard-read-text": "error",
      "landmines/no-cold-import-in-test": "error",
      "landmines/no-cold-start-in-test": "error",
      // Off (1240 findings): contradicts AGENTS.md and the document-code skill, which require JSDoc
      // on every program unit.
      "landmines/no-comments": "off",
      "landmines/no-conditional-expect": "error",
      "landmines/no-elapsed-time-bound": "error",
      "landmines/no-explicit-return-types": "error",
      "landmines/no-fixed-sleep": "error",
      "landmines/no-flake-masking": "error",
      "landmines/no-github-scripts": "error",
      "landmines/no-imported-mutation": "error",
      "landmines/no-inline-hex-encoding": "error",
      "landmines/no-parameter-branch": "error",
      "landmines/no-prefix-cluster": "error",
      "landmines/no-project-max-workers": "error",
      "landmines/no-scripts-directory": "error",
      "landmines/no-self-container-query": "error",
      "landmines/no-shared-signal": "error",
      "landmines/no-silent-catch": "error",
      "landmines/no-stale-render-assertion": "error",
      "landmines/no-styling-class-assertion": "error",
      "landmines/no-test-doubles": "error",
      "landmines/no-unsignaled-poll": "error",
      "landmines/package-exports": "error",
      // Every script that runs a TypeScript file calls a `bin` of `@workspace/tools` or
      // `@workspace/infra` instead; `names` lists the repository's own task names.
      "landmines/package-scripts": [
        "error",
        {
          names: [
            "alchemy",
            "audit",
            "auth:generate",
            "bootstrap",
            "build:prod-harness",
            "check",
            "commitlint",
            "credentials",
            "db:check",
            "db:generate",
            "db:regenerate",
            "design:md",
            "fix",
            "knob",
            "log-key",
            "mirrors",
            "ratchet",
            "renovate:validate",
            "settings",
            "test:browser",
            "test:cloud",
            "ui",
            "ui:lock",
            "ui:typecheck",
          ],
        },
      ],
      // Off (774 findings): `@stylistic/padding-line-between-statements` above already sets the
      // blank-line policy.
      "landmines/padding-between-statements": "off",
      "landmines/strict-msw": "error",
      "landmines/test-dir-only-cross-functional": "error",
      "landmines/test-file-names": "error",
      // Related Effect schemas and errors form one cohesive module.
      "max-classes-per-file": "off",
      "no-restricted-properties": ["error", ...runMembers, ...dataAccessMembers],
      // Reports a value assigned and then overwritten before any read.
      "no-useless-assignment": "error",
      // A `return` in `finally` swallows a thrown error and replaces the result.
      "promise/no-return-in-finally": "error",
      // The Ultracite 8.3 `core` preset turns `sort-keys` off; the 8.1.1 preset had it at `error` with
      // default options, so this keeps the rule the repository already enforced. The scoped
      // overrides above still lift it where key order is the wire or column order.
      "sort-keys": "error",
      // Issue #11 item 10: `ReadonlyArray<T>` is the accepted array spelling.
      "typescript/array-type": ["error", { default: "generic", readonly: "generic" }],
      // `require()` has no place in an ES module repository; the preset leaves it off.
      "typescript/no-require-imports": "error",
      // Effect adapters return existing promises without introducing async wrappers.
      "typescript/promise-function-async": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      // Replaced by `workspace/no-array-method-this-argument`: the same check with `Effect` ignored, since
      // `Effect.forEach(xs, f, { concurrency })` takes options, not a `thisArg`.
      "unicorn/no-array-method-this-argument": "off",
      // Adopted from the Cloudflare Oxlint preset (#437). Ultracite core turns it off; `String.raw`
      // keeps a backslash-heavy literal readable, so it is on again.
      "unicorn/prefer-string-raw": "error",
      // Adopted from the Cloudflare Oxlint preset (#437): a module awaits at the top level instead of
      // chaining a promise. The story override above lifts it.
      "unicorn/prefer-top-level-await": "error",
      // misfires on Schema.TaggedError<X>()(...) calls and takes no options; throw is already banned in source by the Effect-native rule (AGENTS.md)
      "unicorn/throw-new-error": "off",
      "workspace/error-message-grammar": "error",
      "workspace/kebab-case-paths": "error",
      "workspace/no-array-method-this-argument": "error",
      "workspace/no-built-in-try-catch": "error",
      "workspace/no-effect-data-load": "error",
      "workspace/no-effect-on-async-result": "error",
      "workspace/no-hand-built-problem": "error",
      "workspace/no-hand-rolled-retry": "error",
      "workspace/no-keyed-ttl-map": "error",
      "workspace/no-mutable-module-state": "error",
      "workspace/no-raw-form-submit": "error",
    },
    // The shadcn preset finds the components and the theme through these two entries.
    settings: { shadcn: { ui: ["@workspace/ui/components", "apps/web/src/styles/app.css"] } },
  },
  run: {
    tasks: {
      ...testTasks,
      ci: { cache: false, command: "echo ci: every task passed", dependsOn: ciTaskNames },
      // `apps/web/src/server.test.ts` runs `build:prod-harness` into the same `apps/web/dist`, so the
      // production build waits for the `web` tests and overwrites what they leave, as `bun run test`
      // then `bun run build` do today.
      "ci-build-web": {
        cache: { input: sharedInput },
        command: "vp build",
        cwd: "apps/web",
        dependsOn: ["ci-test-web"],
      },
      "ci-bundle-check": {
        cache: { input: sharedInput, output: [] },
        command: "bundle-check",
        dependsOn: ["ci-build-web"],
      },
      // `db-check` and `ratchet` read the repository through `git`, which file tracking does not see, and
      // `hooks-present` asks `git` for `core.hooksPath`; none has a file input that covers what it reads,
      // so all three run on every CI run.
      "ci-db-check": { cache: false, command: "db-check" },
      "ci-design-lint": {
        cache: ciCache,
        command:
          "bun --bun ./node_modules/.bin/design.md lint --format json DESIGN.md | design-md-lint DESIGN.md",
      },
      "ci-fmt": { cache: ciCache, command: "vp fmt --check" },
      "ci-hooks-present": { cache: false, command: "hooks-present" },
      "ci-knip": { cache: ciCache, command: "knip" },
      "ci-lint": { cache: ciCache, command: "vp check --no-fmt --deny-warnings" },
      "ci-ratchet": { cache: false, command: "ratchet" },
      "ci-runbook": { cache: ciCache, command: "runbook-check docs/spin-up.md" },
      "ci-supdoc": { cache: ciCache, command: "supdoc check --deny-warnings" },
      "ci-test-bun-mjs": { cache: ciCache, command: "bun test .test.mjs" },
      "ci-typecheck": { cache: ciCache, command: "vp check --no-fmt --no-lint" },
      "ci-ui-typecheck": { cache: ciCache, command: "tsc --noEmit -p .", cwd: "packages/ui" },
    },
  },
  // Tests run on Vitest with @effect/vitest. The lint-rule tests in tools/lint import bun:test
  // and run under `bun test`; `bun run test` runs both.
  //
  // Versions in use: Vitest 5.1.0 (bundled by Vite+ 1.7.0), Miniflare 4.20260730.0, workerd
  // 1.20261026.1. `@cloudflare/vitest-pool-workers` is not used: it failed under Vitest 5.1.0 and
  // its successor cannot load an Alchemy Worker module, so tier 2 is Miniflare's local D1 plus
  // Alchemy's `dev` harness.
  test: {
    // The deploy guard: every default project inherits it, and `vite.cloud.config.ts` never sets it.
    env: { ALCHEMY_TEST_DEV: "1" },
    projects: testProjects,
  },
});
