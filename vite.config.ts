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

import { restrictImports } from "./tools/lint/rules/restrict-imports.ts";

import {
  dataAccessMembers,
  fetchMessage,
  globalThisFetch,
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
 * R1: an app imports another app only through its contract, and never imports infra. Web overrides
 * repeat it because an override replaces the options of every earlier matching override.
 */
const appImports = [
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
 * Status toasts: screens raise them through `notify`, which is the one module that imports
 * `sonner`.
 */
const noSonner = {
  message: "raise toasts through notify in apps/web/src/components/notify.ts, not sonner directly",
  name: "sonner",
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
      "tools/lint/fixtures/**",
      "work/**",
      ...vendored,
    ],
    jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
  },
  lint: {
    // `drizzle` is adopted although it has no oxlint rules today, so a later Drizzle rule arrives
    // with the preset. `react` and `vitest` are scoped in `overrides` below. `tanstack` is not
    // adopted: it turns `sort-keys` off for the whole repository and the kebab-case filename rule
    // off under `routes/`; two of its decisions are copied as scoped overrides instead.
    extends: [core, antiSlop, shadcn, drizzle],
    ignorePatterns: [
      ".agents/**",
      ".mirrors/**",
      ".worktrees/**",
      "**/*.gen.ts",
      "apps/auth/src/db/schema.ts",
      "**/migrations/**",
      "dist/**",
      "tools/lint/fixtures/**",
      "work/**",
      ...vendored,
    ],
    jsPlugins: ["./tools/lint/plugin.mjs", "@stylistic/eslint-plugin"],
    // `vp check` runs type-aware rules and the type check only when both are enabled.
    // https://viteplus.dev/guide/check
    options: { typeAware: true, typeCheck: true },
    overrides: [
      // The run-family import ban covers every source file; the scoped overrides below repeat it.
      restrictImports(["**/*.ts", "**/*.tsx"], {}),
      // Runtime boundary: tests bridge stubs to Promise APIs.
      restrictImports(["**/*.test.ts"], { base: false }),
      restrictImports(["apps/*/src/**"], { patterns: appImports }),
      restrictImports(["packages/contract/src/domain/**"], {
        patterns: [
          {
            group: ["effect/http", "effect/http/*", "@alchemy.run/*", "../api/*", "**/api/*"],
            message:
              "the domain imports no HTTP server module, no Alchemy and no api module; effect/http-api is allowed because the Problem classes are the domain's error model",
          },
        ],
      }),
      restrictImports(["apps/web/src/**"], {
        paths: [noServerFunctions, noSonner],
        patterns: [...appImports, webContracts, workersModule],
      }),
      // `notify` is the one module that imports `sonner`; it keeps every other web ban.
      restrictImports(["apps/web/src/components/notify.ts"], {
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
      // `worker.ts` composes `HttpApiBuilder` layers from the http modules; it keeps R1.
      restrictImports(["apps/api/src/worker.ts", "apps/auth/src/worker.ts"], {
        patterns: appImports,
      }),
      // Tests compose handlers; they keep R1 but not R7, and lift the run-family ban.
      restrictImports(["apps/api/src/**/*.test.ts", "apps/auth/src/**/*.test.ts"], {
        base: false,
        patterns: appImports,
      }),
      // Handlers may use `HttpApiBuilder`; they keep R1 and import no database module.
      restrictImports(["apps/api/src/**/http.ts", "apps/auth/src/**/http.ts"], {
        patterns: [...appImports, dbModules],
      }),
      {
        // The data modules lift the data-access bans and keep the run-family ban. Overrides replace
        // options, so each list below is exact.
        files: ["packages/db/src/**"],
        rules: { "no-restricted-properties": ["error", ...runMembers] },
      },
      {
        // `web` reaches `auth` only through `env.AUTH.fetch(...)` (C34). Bare `fetch` is banned by
        // `no-restricted-globals` below; `globalThis.fetch` joins the member lists, which every
        // override under apps/web/src repeats because overrides replace options.
        files: ["apps/web/src/**"],
        rules: {
          "no-restricted-globals": ["error", { message: fetchMessage, name: "fetch" }],
          "no-restricted-properties": [
            "error",
            ...runMembers,
            ...dataAccessMembers,
            globalThisFetch,
          ],
        },
      },
      {
        // The web run boundaries lift the run-family ban and keep the data-access and fetch bans.
        files: ["apps/web/src/runtime.ts", "apps/web/src/server.ts"],
        rules: { "no-restricted-properties": ["error", ...dataAccessMembers, globalThisFetch] },
      },
      {
        // The auth reclaim statement is one guarded compare-and-delete: a named data module that
        // keeps the run-family ban.
        files: ["apps/auth/src/reclaim.ts"],
        rules: { "no-restricted-properties": ["error", ...runMembers] },
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
          "react-doctor/only-export-components": "off",
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
      // Related Effect schemas and errors form one cohesive module.
      "max-classes-per-file": "off",
      "no-restricted-properties": ["error", ...runMembers, ...dataAccessMembers],
      // Issue #11 item 10: `ReadonlyArray<T>` is the accepted array spelling.
      "typescript/array-type": ["error", { default: "generic", readonly: "generic" }],
      // Effect adapters return existing promises without introducing async wrappers.
      "typescript/promise-function-async": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      // misfires on Schema.TaggedError<X>()(...) calls and takes no options; throw is already banned in source by the Effect-native rule (AGENTS.md)
      "unicorn/throw-new-error": "off",
      "workspace/error-message-grammar": "error",
      "workspace/kebab-case-paths": "error",
      "workspace/no-built-in-try-catch": "error",
      "workspace/no-mutable-module-state": "error",
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
          exclude: ["tools/lint/fixtures/**"],
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
      // block:knobs-kv start
      { test: { ...noOnly, include: ["packages/knobs-kv/src/**/*.test.ts"], name: "knobs-kv" } },
      // block:knobs-kv end
      { test: { ...noOnly, include: ["infra/**/*.test.ts"], name: "infra" } },
      // block:budget-guard start
      {
        test: {
          ...noOnly,
          include: ["packages/budget-guard/src/**/*.test.ts"],
          name: "budget-guard",
        },
      },
      // block:budget-guard end
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
