import { defineConfig } from "vite-plus";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";
import shadcn from "ultracite/oxlint/shadcn";
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

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".agents/**",
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
    extends: [core, antiSlop, shadcn],
    ignorePatterns: [
      ".agents/**",
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
      ],
      // Related Effect schemas and errors form one cohesive module.
      "max-classes-per-file": "off",
      "no-restricted-properties": ["error", ...runMembers, ...dataAccessMembers],
      // Effect adapters return existing promises without introducing async wrappers.
      "typescript/promise-function-async": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      // misfires on Schema.TaggedError<X>()(...) calls and takes no options; throw is already banned in source by the Effect-native rule (AGENTS.md)
      "unicorn/throw-new-error": "off",
      "workspace/kebab-case-paths": "error",
      "workspace/no-built-in-try-catch": "error",
      "workspace/no-mutable-module-state": "error",
    },
    // The shadcn preset finds the components and the theme through these two entries.
    settings: { shadcn: { ui: ["@workspace/ui/components", "apps/web/src/styles/app.css"] } },
  },
  // Tests run on Vitest with @effect/vitest. The lint-rule tests in tools/lint import bun:test
  // and run under `bun test`; `bun run test` runs both.
  test: {
    projects: [
      {
        test: {
          exclude: ["tools/lint/fixtures/**"],
          include: ["tools/**/*.test.ts"],
          name: "tools",
        },
      },
      { test: { include: ["test/**/*.test.ts"], name: "root" } },
      { test: { include: ["apps/web/src/**/*.test.ts"], name: "web" } },
      { test: { include: ["apps/api/src/**/*.test.ts"], name: "api" } },
      { test: { include: ["apps/auth/src/**/*.test.ts"], name: "auth" } },
      { test: { include: ["packages/contract/src/**/*.test.ts"], name: "contract" } },
      { test: { include: ["packages/db/src/**/*.test.ts"], name: "db" } },
      { test: { include: ["packages/config/src/**/*.test.ts"], name: "config" } },
      { test: { include: ["infra/**/*.test.ts"], name: "infra" } },
    ],
  },
});
