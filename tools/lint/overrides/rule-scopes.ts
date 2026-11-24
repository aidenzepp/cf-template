import type { ViteUserConfig } from "vite-plus";
import react from "ultracite/oxlint/react";
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
} from "../rules/restricted-globals.ts";
import {
  authFetchMembers,
  dataAccessMembers,
  dataAccessMembersWithoutPrepare,
  globalThisFetch,
  registryMembers,
  runMembers,
} from "../rules/restricted-properties.ts";

/**
 * The source of every app and package: the files the capability registry guards
 * (`docs/capabilities.md`). Tests lift the properties ban and `packages` tests lift the rest.
 */
const sourceFiles = ["apps/*/src/**", "packages/*/src/**"];

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
 * The scoped `lint.overrides` entries that follow the import restrictions: the capability
 * registry's guards on source, the framework presets, and the files that lift a rule with a reason.
 */
export const ruleScopeOverrides: NonNullable<NonNullable<ViteUserConfig["lint"]>["overrides"]> = [
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
    // Lifted until #244 moves the log to Effect.logError (want 3bb9a4ad). No alert reads the
    // `web.ratelimit.error` line any more; it reaches Workers Logs only.
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
    // of the Effect, which `.then(onFulfilled, onRejected)` consumes. `prefer-catch` is off
    // too: `.catch` would also catch a throw from `onFulfilled`, which changes the thenable.
    files: ["apps/auth/src/auth.ts"],
    rules: { "promise/prefer-await-to-then": "off", "promise/prefer-catch": "off" },
  },
  {
    // Alchemy Domain Stories assert recorded events with `Story.then(...)`, a step of the
    // Story DSL, not a promise. Story files are declarative step lists and run no promises.
    // `prefer-catch` is off too: it reads `Story.then(subject, event)` as `then(a, b)`.
    // `prefer-top-level-await` is off too: it reads `Story.then(...)` as a promise chain.
    files: ["**/*.story.ts"],
    rules: {
      "promise/prefer-await-to-then": "off",
      "promise/prefer-catch": "off",
      "unicorn/prefer-top-level-await": "off",
    },
  },
  {
    // The cloud suite's and the `tools` project's Vitest global setups and the browser tier's
    // `scan` command are run boundaries: Vitest calls a plain async function, so the Effect that
    // validates the stage and runs `alchemy`, that runs the Better Auth CLI, or that builds the
    // harness and runs axe-core, runs here. They keep the data-access bans.
    files: [
      "test/cloud/global-setup.ts",
      "tools/db/global-setup.ts",
      "test/browser/support/browser-harness.ts",
    ],
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
    rules: {
      ...react.rules,
      // Adopted from the Cloudflare Oxlint preset (#437); the preset leaves both off.
      "react/no-unknown-property": "error",
      "react/require-render-return": "error",
    },
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
      // The two server-data guards `docs/capabilities.md` names. Neither is in a React Doctor
      // rule set, so each is switched on here.
      "react-doctor/no-collapse-request-error-to-empty-state": "error",
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
    // Adopted from the Cloudflare Oxlint preset (#437), scoped to plain JavaScript as there: the
    // TypeScript checker already reports an undefined name in a `.ts` file. The preset's
    // `browser` and `node` environments are scoped with it: the lint-rule tests run on Bun and
    // the bundle fixtures stand in for browser assets.
    env: { browser: true, node: true },
    files: ["**/*.{js,mjs,cjs}"],
    rules: { "no-undef": "error" },
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
    files: ["packages/contract/**", "**/*.test.ts", "tools/lint/rules/no-hand-built-problem.ts"],
    rules: { "workspace/no-hand-built-problem": "off" },
  },
  {
    // Lifted until #245 builds these problem responses with `ProblemDetails`.
    files: ["apps/web/src/forward.ts", "apps/web/src/ratelimit.ts"],
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
];
