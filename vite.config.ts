import { defineConfig } from "vite-plus";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";
import shadcn from "ultracite/oxlint/shadcn";

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

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".agents/**",
      ".worktrees/**",
      "apps/auth/src/db/schema.ts",
      "bun.lock",
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
      "apps/auth/src/db/schema.ts",
      "dist/**",
      "work/**",
      ...vendored,
    ],
    jsPlugins: ["./tools/lint/plugin.mjs", "@stylistic/eslint-plugin"],
    // `vp check` runs type-aware rules and the type check only when both are enabled.
    // https://viteplus.dev/guide/check
    options: { typeAware: true, typeCheck: true },
    overrides: [
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
      // Effect adapters return existing promises without introducing async wrappers.
      "typescript/promise-function-async": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      // misfires on Schema.TaggedError<X>()(...) calls and takes no options; throw is already banned in source by the Effect-native rule (AGENTS.md)
      "unicorn/throw-new-error": "off",
      "workspace/kebab-case-paths": "error",
      "workspace/no-built-in-try-catch": "error",
    },
  },
  // Tests run on Vitest with @effect/vitest. The lint-rule tests in tools/lint import bun:test
  // and run under `bun test`; `bun run test` runs both.
  test: {
    projects: [
      { test: { exclude: ["tools/lint/**"], include: ["tools/**/*.test.ts"], name: "tools" } },
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
