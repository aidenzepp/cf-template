import { nodeBuiltins, restrictImports } from "../rules/restrict-imports.ts";

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
 * The `lint.overrides` entries that restrict imports, in the order the config applies them. The
 * run-family import ban covers every source file; the scoped entries repeat it, because an override
 * replaces the options of every earlier matching override.
 */
export const importRestrictionOverrides = [
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
];
