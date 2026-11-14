import { recommended as effect } from "@effect/tsgo/oxlint-presets";

import { defineConfig } from "vite-plus";

import core from "ultracite/oxlint/core";

import antiSlop from "ultracite/oxlint/anti-slop";

import drizzle from "ultracite/oxlint/drizzle";

import react from "ultracite/oxlint/react";

import shadcn from "ultracite/oxlint/shadcn";

import vitest from "ultracite/oxlint/vitest";

import {
  REACT_COMPILER_RULES,
  RECOMMENDED_RULES,
  TANSTACK_START_RULES,
} from "oxlint-plugin-react-doctor";

import {
  abortGlobal,
  platformGlobals,
  sourceFetch,
  webFetch,
} from "./tools/lint/rules/restricted-globals.ts";

import { nodeBuiltins, restrictImports } from "./tools/lint/rules/restrict-imports.ts";

import {
  authFetchMembers,
  dataAccessMembers,
  dataAccessMembersWithoutPrepare,
  globalThisFetch,
  registryMembers,
  runMembers,
} from "./tools/lint/rules/restricted-properties.ts";

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
 * The source of every app and package: the files the capability registry guards
 * (`docs/capabilities.md`). Tests lift the properties ban and `packages` tests lift the rest.
 */
const sourceFiles = ["apps/*/src/**", "packages/*/src/**"];

/**
 * R1: an app imports another app only through its contract, and never imports infra.
 */
const appRules = [
  {
    group: [
      "@workspace/web",
      "@workspace/web/*",
      "@workspace/api",
      "@workspace/api/*",
      "@workspace/auth",
      "@workspace/auth/*",
      "!@workspace/*/contract",
    ],
    message: "an app imports another app only as @workspace/<app>/contract",
  },
  { group: ["@workspace/infra", "@workspace/infra/*"], message: "an app never imports infra" },
];

/**
 * Everything an app source file may not import by pattern: R1, and `node:*`. Web overrides repeat
 * it because an override replaces the options of every earlier matching override.
 */
const appImports = [...appRules, nodeBuiltins];

/**
 * R5: browser code imports no app contract; the server entry is the exception (ST10).
 */
const webContracts = {
  group: ["@workspace/api/contract", "@workspace/auth/contract"],
  message: "browser code imports no app contract; the server entry is the exception",
};

/**
 * R5: `cloudflare:workers` is a server runtime module. `server.ts`, `runtime.ts` and
 * `api-client.ts` are the ruled boundaries that read the bindings; tests may also import it.
 */
const workersModule = { group: ["cloudflare:workers"] };

/**
 * R5: no server functions in `web` (ST10), including from the server entry.
 */
const noServerFunctions = {
  importNames: ["createServerFn"],
  message: "no server functions in web (ST10)",
  name: "@tanstack/react-start",
};

/**
 * R7: services build no HTTP; handlers live in `**\/http.ts`. `worker.ts` composes the
 * `HttpApiBuilder` layers and lifts this ban.
 */
const noHttpBuilder = {
  importNames: ["HttpApiBuilder"],
  message: "services do not build HTTP; handlers live in **/http.ts",
  name: "effect/http-api",
};

/**
 * R7: services import no handler module.
 */
const httpModules = {
  group: ["./http", "../http", "./**/http", "../**/http"],
  message: "services import no handler module; handlers live in **/http.ts",
};

/**
 * R8: handlers import no database module.
 */
const dbModules = {
  group: ["./db/*", "../db/*", "**/db/*"],
  message: "handlers import no database module",
};

/**
 * The repository's Vitest suites; the lint-rule fixtures are inputs, not suites.
 */
const testFiles = [
  "apps/*/src/**/*.test.ts",
  "packages/*/src/**/*.test.ts",
  "infra/**/*.test.ts",
  "tools/**/*.test.ts",
  "test/**/*.test.ts",
];

/**
 * The rules of the Ultracite `vitest` preset, read from its single override.
 */
const presetRules = vitest.overrides?.[0]?.rules ?? {};

/**
 * A committed `.only` would silently skip every other test in its file; Vitest defaults `allowOnly`
 * to on outside CI, so each project turns it off and a focused test fails the run everywhere.
 */
const noOnly = { allowOnly: false };

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
    // `effect-tsgo patch --oxlint` has patched the toolchain, and the canary test turns red if not.
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
    jsPlugins: ["./tools/lint/plugin.mjs", "@stylistic/eslint-plugin", ...shadcn.jsPlugins],
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
      // The run-family import ban covers every source file; the scoped overrides below repeat it.
      restrictImports(["**/*.ts", "**/*.tsx"], {}),
      // Runtime boundary: tests bridge stubs to Promise APIs.
      restrictImports(["**/*.test.ts"], { base: false, sql: false }),
      restrictImports(["apps/*/src/**"], { patterns: appImports }),
      // Package source imports no `node:*` module; its tests lift that ban and the run-family ban.
      restrictImports(["packages/*/src/**"], { patterns: [nodeBuiltins] }),
      // `packages/db` and every `table.ts` under `packages` build SQL on purpose (schema DDL, the
      // database module itself), so they lift the raw-SQL import ban.
      restrictImports(["packages/db/src/**", "packages/*/src/**/table.ts"], {
        patterns: [nodeBuiltins],
        sql: false,
      }),
      restrictImports(["packages/*/src/**/*.test.ts"], { base: false, sql: false }),
      restrictImports(["packages/contract/src/domain/**"], {
        patterns: [
          nodeBuiltins,
          {
            group: ["effect/http", "effect/http/*", "@alchemy.run/*", "../api/*", "**/api/*"],
            message:
              "the domain imports no HTTP server module, no Alchemy and no api module; effect/http-api is allowed because the Problem classes are the domain's error model",
          },
        ],
      }),
      restrictImports(["apps/web/src/**"], {
        paths: [noServerFunctions],
        patterns: [...appImports, webContracts, workersModule],
      }),
      // The server entry reads the bindings and imports `@workspace/auth/contract` (the credential
      // paths); it keeps the createServerFn ban.
      // It is also a run boundary: the rate-limit check runs before the forward.
      restrictImports(["apps/web/src/server.ts"], {
        base: false,
        paths: [noServerFunctions],
        patterns: appImports,
      }),
      // `runtime.ts` and `api-client.ts` read the bindings: they lift only the `cloudflare:workers`
      // group. `runtime.ts` is also the run boundary of `web`.
      restrictImports(["apps/web/src/runtime.ts"], {
        base: false,
        paths: [noServerFunctions],
        patterns: [...appImports, webContracts],
      }),
      restrictImports(["apps/web/src/api-client.ts"], {
        paths: [noServerFunctions],
        patterns: [...appImports, webContracts],
      }),
      // Tests lift the `cloudflare:workers` group and the run-family ban.
      restrictImports(["apps/web/src/**/*.test.ts"], {
        base: false,
        paths: [noServerFunctions],
        patterns: [...appImports, webContracts],
        sql: false,
      }),
      restrictImports(["apps/api/src/**", "apps/auth/src/**"], {
        paths: [noHttpBuilder],
        patterns: [...appImports, httpModules],
      }),
      // `auth.ts` is the run boundary of `auth` (the one Effect-to-Promise seam); it keeps R1 and R7.
      restrictImports(["apps/auth/src/auth.ts"], {
        base: false,
        paths: [noHttpBuilder],
        patterns: [...appImports, httpModules],
      }),
      // `password.ts` is the project's one scrypt call: Effect has no scrypt (its `Kdf` is PBKDF2
      // only) and Workers serve it only through `node:crypto` (the file's own comment). It lifts
      // only `node:*`.
      restrictImports(["apps/auth/src/password.ts"], {
        paths: [noHttpBuilder],
        patterns: [...appRules, httpModules],
      }),
      // `worker.ts` composes `HttpApiBuilder` layers from the http modules; it keeps R1.
      restrictImports(["apps/api/src/worker.ts", "apps/auth/src/worker.ts"], {
        patterns: appImports,
      }),
      // Tests compose handlers; they keep R1 but not R7, and lift the run-family ban.
      restrictImports(["apps/api/src/**/*.test.ts", "apps/auth/src/**/*.test.ts"], {
        base: false,
        patterns: appImports,
        sql: false,
      }),
      // Handlers may use `HttpApiBuilder`; they keep R1 and import no database module.
      restrictImports(["apps/api/src/**/http.ts", "apps/auth/src/**/http.ts"], {
        patterns: [...appImports, dbModules],
      }),
      // The attach files import the block live Layers (#232); each repeats its app's restrictions.
      restrictImports(["apps/api/src/blocks.ts", "apps/auth/src/blocks.ts"], {
        blockLayers: false,
        paths: [noHttpBuilder],
        patterns: [...appImports, httpModules],
      }),
      restrictImports(["apps/web/src/blocks.ts", "apps/web/src/request-layers.ts"], {
        blockLayers: false,
        paths: [noServerFunctions],
        patterns: [...appImports, webContracts, workersModule],
      }),
      // Raw-SQL exceptions, each with its reason. `table.ts` is schema DDL (a `check(...)`
      // constraint is SQL text); `reclaim.ts` is the guarded `DELETE ... NOT EXISTS`, a named data
      // module; `test-harness.ts` is test support that seeds the D1 binding.
      restrictImports(["apps/api/src/**/table.ts", "apps/auth/src/**/table.ts"], {
        paths: [noHttpBuilder],
        patterns: [...appImports, httpModules],
        sql: false,
      }),
      restrictImports(["apps/auth/src/reclaim.ts", "apps/auth/src/test-harness.ts"], {
        paths: [noHttpBuilder],
        patterns: [...appImports, httpModules],
        sql: false,
      }),
      {
        // The capability registry's built-in guards (`docs/capabilities.md`, work order A2) on all
        // source. Overrides replace options, so each list below and in the overrides after this one
        // is exact. `no-console` takes no options: logs go through `Effect.log*`.
        files: sourceFiles,
        rules: {
          "no-console": "error",
          "no-restricted-globals": ["error", abortGlobal, ...platformGlobals, sourceFetch],
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembers,
            ...registryMembers,
          ],
          "promise/prefer-await-to-then": "error",
        },
      },
      {
        // The data modules lift the data-access bans and keep the run-family and registry bans.
        files: ["packages/db/src/**"],
        rules: { "no-restricted-properties": ["error", ...runMembers, ...registryMembers] },
      },
      {
        // `web` reaches `auth` only through `env.AUTH.fetch(...)` (C34), so its bare `fetch` ban
        // carries that message. `globalThis.fetch` joins the member lists, which every override
        // under apps/web/src repeats because overrides replace options.
        files: ["apps/web/src/**"],
        rules: {
          "no-restricted-globals": ["error", abortGlobal, ...platformGlobals, webFetch],
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembers,
            ...registryMembers,
            globalThisFetch,
          ],
        },
      },
      {
        // The web run boundaries lift the run-family ban and keep the data-access, registry and
        // fetch bans.
        files: ["apps/web/src/runtime.ts", "apps/web/src/server.ts"],
        rules: {
          "no-restricted-properties": [
            "error",
            ...dataAccessMembers,
            ...registryMembers,
            globalThisFetch,
          ],
        },
      },
      {
        // The auth reclaim statement is one guarded compare-and-delete: a named data module that
        // keeps the run-family and registry bans.
        files: ["apps/auth/src/reclaim.ts"],
        rules: { "no-restricted-properties": ["error", ...runMembers, ...registryMembers] },
      },
      {
        // `latch.ts` is lifted until #249 removes it: the latch record is written with
        // `JSON.stringify`. `test-harness.ts` is test support.
        files: ["packages/budget-guard/src/latch.ts"],
        rules: {
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembers,
            ...authFetchMembers,
          ],
        },
      },
      {
        // `test-harness.ts` applies the migrations through the D1 binding's `prepare`.
        files: ["apps/auth/src/test-harness.ts"],
        rules: {
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembersWithoutPrepare,
            ...authFetchMembers,
          ],
        },
      },
      {
        // Lifted until #244 moves the log to Effect.logError and updates the web.ratelimit.error
        // alert query with a cloud proof: the alert reads a top-level `event` that the structured
        // logger would nest (want 3bb9a4ad).
        files: ["apps/web/src/ratelimit.ts"],
        rules: {
          "no-console": "off",
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembers,
            ...authFetchMembers,
            globalThisFetch,
          ],
          "promise/prefer-await-to-then": "off",
        },
      },
      {
        // `auth.ts` is the documented Effect-to-Promise seam: Better Auth takes a promise view
        // of the Effect, which `.then(onFulfilled, onRejected)` consumes.
        files: ["apps/auth/src/auth.ts"],
        rules: { "promise/prefer-await-to-then": "off" },
      },
      {
        // Alchemy Domain Stories assert recorded events with `Story.then(...)`, a step of the
        // Story DSL, not a promise. Story files are declarative step lists and run no promises.
        files: ["**/*.story.ts"],
        rules: { "promise/prefer-await-to-then": "off" },
      },
      {
        // The cloud suite's Vitest global setup and the browser tier's `scan` command are run
        // boundaries: Vitest calls a plain async function, so the Effect that validates the stage
        // and runs `alchemy`, or that builds the harness and runs axe-core, runs here. They keep
        // the data-access bans.
        files: ["test/cloud/global-setup.ts", "test/browser/support/browser-harness.ts"],
        rules: { "no-restricted-properties": ["error", ...dataAccessMembers] },
      },
      {
        // Tests set up and read the database on purpose, so they lift the run-family and
        // data-access bans.
        files: ["**/*.test.ts"],
        rules: { "no-restricted-properties": "off" },
      },
      {
        // Web tests still never reach the network through `globalThis.fetch`.
        files: ["apps/web/src/**/*.test.ts"],
        rules: { "no-restricted-properties": ["error", globalThisFetch] },
      },
      {
        // The auth promise view is both a run boundary and a data boundary (it writes through
        // `batch`).
        files: ["apps/auth/src/auth.ts"],
        rules: { "no-restricted-properties": "off" },
      },
      {
        // `react` is scoped to the web components: the root preset fired `react-hooks/rules-of-hooks`
        // on Effect `Service.use(...)` calls elsewhere.
        files: ["apps/web/**/*.tsx"],
        plugins: react.plugins,
        rules: react.rules,
      },
      {
        // React Doctor's per-file rules, scoped to `apps/web` like `react` above: the recommended set
        // plus the TanStack Start rules the CLI adds for this framework. Project-wide rules (cycles,
        // unused dependencies) need the CLI and do nothing under oxlint; the CLI is not installed.
        files: ["apps/web/**/*.{ts,tsx}"],
        // `react-hooks-js` is the React Compiler's own diagnostics (`eslint-plugin-react-hooks` 7):
        // each rule flags code the compiler bails out of, which React Doctor's rule keys name.
        jsPlugins: [
          "oxlint-plugin-react-doctor",
          { name: "react-hooks-js", specifier: "eslint-plugin-react-hooks" },
        ],
        rules: {
          ...REACT_COMPILER_RULES,
          ...RECOMMENDED_RULES,
          ...TANSTACK_START_RULES,
          // Findings in existing `apps/web` code at adoption (58 diagnostics). `vp check` denies
          // warnings, so they are off until a follow-up fixes the code; then delete these lines.
          "react-doctor/jsx-no-jsx-as-prop": "off",
          "react-doctor/jsx-no-new-function-as-prop": "off",
          // The two server-data guards `docs/capabilities.md` names. Neither is in a React Doctor
          // rule set, so each is switched on here.
          "react-doctor/no-collapse-request-error-to-empty-state": "error",
          "react-doctor/only-export-components": "off",
          "react-doctor/tanstack-start-no-direct-fetch-in-loader": "error",
        },
      },
      {
        // Copied from the `tanstack` preset: file routes are mutually recursive (`Route` references the
        // component, which calls `Route.useParams()`), so no declaration order satisfies the rule and
        // `tsc` still catches real temporal-dead-zone crashes.
        files: ["apps/web/src/routes/**"],
        rules: { "no-use-before-define": "off" },
      },
      {
        // Copied from the `tanstack` preset: TypeScript infers the generic parameters of
        // `createFileRoute` and the query and mutation options from their callbacks in source order,
        // so alphabetical keys break inference.
        // Schema field order is the wire order of a contract and the column order of a table, so
        // `packages/contract/src/**` and every `table.ts` keep it too.
        files: ["apps/web/src/**", "packages/contract/src/**", "**/table.ts"],
        rules: { "sort-keys": "off" },
      },
      {
        // The lint-rule tests import bun:test from plain JavaScript. The type-aware checker does
        // not load those types for an .mjs file; the tests still run under bun test.
        files: ["tools/**/*.test.mjs"],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
      {
        // `runtime.ts` is the named web runtime boundary: the lazy per-isolate ManagedRuntime and the
        // browser-only hydrated copies are the module state that boundary owns (Mind ruling, I-28f).
        files: ["apps/web/src/runtime.ts"],
        rules: { "workspace/no-mutable-module-state": "off" },
      },
      {
        // `packages/contract` defines the Problem classes, so it writes the media type. Tests assert
        // it on the wire, and the rule's own file names it to look for it.
        files: [
          "packages/contract/**",
          "**/*.test.ts",
          "tools/lint/rules/no-hand-built-problem.ts",
        ],
        rules: { "workspace/no-hand-built-problem": "off" },
      },
      {
        // Lifted until #245 builds these problem responses with `ProblemDetails`.
        files: [
          "apps/web/src/forward.ts",
          "apps/web/src/ratelimit.ts",
          "packages/budget-guard/src/live.ts",
        ],
        rules: { "workspace/no-hand-built-problem": "off" },
      },
      {
        // `fromSource`'s per-isolate knob cache stays a `Map` (#248, #247): Effect `Cache` shares
        // in-flight lookups, which the Workers request boundary forbids.
        files: ["packages/config/src/knob.ts"],
        rules: { "workspace/no-keyed-ttl-map": "off" },
      },
      {
        // The Ultracite `vitest` preset, scoped to the repository's own test files. The preset's own
        // globs also match `.mjs` suites, which run under `bun:test`, so its rules are re-scoped here
        // instead of adopted through `extends`.
        files: testFiles,
        plugins: ["vitest"],
        rules: {
          ...presetRules,
          // `it` is the repository's one test form (@effect/vitest exports no `test`), and the
          // autofix to `test` renamed calls without importing it.
          "vitest/consistent-test-it": ["error", { fn: "it", withinDescribe: "it" }],
          // `expect` runs inside the callback of an @effect/vitest test form, which the rule does not
          // know as a test block.
          "vitest/no-standalone-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it.effect",
                "it.scoped",
                "it.live",
                "it.layer",
                "it.effect.each",
                "layer",
              ],
            },
          ],
          // `layer(...)` suites from @effect/vitest are not describe blocks, and the describe titles
          // here name the unit under test, which is often an imported function.
          "vitest/prefer-describe-function-title": "off",
          "vitest/require-top-level-describe": "off",
        },
      },
    ],
    rules: {
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
      // Related Effect schemas and errors form one cohesive module.
      "max-classes-per-file": "off",
      "no-restricted-properties": ["error", ...runMembers, ...dataAccessMembers],
      // Issue #11 item 10: `ReadonlyArray<T>` is the accepted array spelling.
      "typescript/array-type": ["error", { default: "generic", readonly: "generic" }],
      // Effect adapters return existing promises without introducing async wrappers.
      "typescript/promise-function-async": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      // Replaced by `workspace/no-array-method-this-argument`: the same check with `Effect` ignored, since
      // `Effect.forEach(xs, f, { concurrency })` takes options, not a `thisArg`.
      "unicorn/no-array-method-this-argument": "off",
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
  // Tests run on Vitest with @effect/vitest. The lint-rule tests in tools/lint import bun:test
  // and run under `bun test`; `bun run test` runs both.
  //
  // Versions in use: Vitest 5.1.0 (bundled by Vite+ 1.5.0), Miniflare 4.20260730.0, workerd
  // 1.20261026.1. `@cloudflare/vitest-pool-workers` is not used: it failed under Vitest 5.1.0 and
  // its successor cannot load an Alchemy Worker module, so tier 2 is Miniflare's local D1 plus
  // Alchemy's `dev` harness.
  test: {
    // The deploy guard: every default project inherits it, and `vite.cloud.config.ts` never sets it.
    env: { ALCHEMY_TEST_DEV: "1" },
    projects: [
      {
        test: {
          ...noOnly,
          exclude: ["tools/lint/fixtures/**", "tools/ratchet/fixtures/**"],
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
      { test: { ...noOnly, include: ["packages/contract/src/**/*.test.ts"], name: "contract" } },
      { test: { ...noOnly, include: ["packages/db/src/**/*.test.ts"], name: "db" } },
      { test: { ...noOnly, include: ["packages/config/src/**/*.test.ts"], name: "config" } },
      { test: { ...noOnly, include: ["packages/knobs-kv/src/**/*.test.ts"], name: "knobs-kv" } },
      { test: { ...noOnly, include: ["infra/**/*.test.ts"], name: "infra" } },
      {
        test: {
          ...noOnly,
          include: ["packages/budget-guard/src/**/*.test.ts"],
          name: "budget-guard",
        },
      },
      {
        test: {
          ...noOnly,
          include: ["test/local/**/*.test.ts"],
          name: "local",
          setupFiles: ["test/local/setup.ts"],
        },
      },
      { test: { ...noOnly, include: ["test/e2e/**/*.e2e.ts"], name: "e2e-local" } },
    ],
  },
});
