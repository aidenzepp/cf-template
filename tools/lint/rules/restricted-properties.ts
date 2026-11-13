/**
 * The `run[A-Z]*` exports of `effect/Effect`. `ManagedRuntime` methods share these names, so one
 * list bans both. `tools/lint/run-family.test.ts` pins it to the installed Effect.
 */
export const runNames = [
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
] as const;

/**
 * The message every run-family diagnostic carries.
 */
export const runMessage = "Effect.run* only at a runtime boundary";

/**
 * The `no-restricted-properties` entries of the root rule: one per run-family name, so a member
 * call on `Effect` or on a `ManagedRuntime` is banned.
 */
export const runMembers = runNames.map((property) => ({ message: runMessage, property }));

/**
 * The message both `web` fetch bans carry: the bare global (`no-restricted-globals`) and
 * `globalThis.fetch` (`globalThisFetch`).
 */
export const fetchMessage = "apps/web may call fetch only on the AUTH binding: env.AUTH.fetch(...)";

/**
 * The `globalThis.fetch` entry of `no-restricted-properties`, appended to every list that applies
 * under `apps/web/src`.
 */
export const globalThisFetch = { message: fetchMessage, object: "globalThis", property: "fetch" };

/**
 * The two `no-restricted-properties` entries that ban a Better Auth `$fetch` call (registry row
 * "Auth client"). Both receiver names are the client the repository binds.
 */
export const authFetchMembers = ["client", "authClient"].map((object) => ({
  message:
    "call the typed Better Auth client actions and use* atoms, never $fetch (docs/capabilities.md, Auth client)",
  object,
  property: "$fetch",
}));

/**
 * The `JSON.stringify` entry of `no-restricted-properties` (registry row "JSON encoding").
 */
export const jsonStringifyMember = {
  message:
    "encode with a Schema (Schema.fromJsonString), and log through Effect.annotateLogs (docs/capabilities.md, JSON encoding)",
  object: "JSON",
  property: "stringify",
};

/**
 * The registry-owned entries every source list carries; tests and tools lift them.
 */
export const registryMembers = [...authFetchMembers, jsonStringifyMember];

/**
 * The message every data-access diagnostic carries.
 */
export const dataMessage =
  "database writes and raw SQL only in packages/db or the auth promise view";

/**
 * Names banned on any object: today they occur only in `packages/db/src/batch.ts`.
 */
const dataNames = ["transaction", "withTransaction", "unsafe", "batch"] as const;

/**
 * The Drizzle raw-execution family. `run`, `all`, `get` and `values` are everyday names on `Map`,
 * `Effect` and arrays, so they are banned only on the Drizzle handle object names below.
 */
const rawNames = ["run", "all", "get", "values"] as const;

/**
 * The names a Drizzle database or transaction handle is bound to.
 */
const handleObjects = ["db", "tx", "database"] as const;

/**
 * The data-access entries of the root rule: the four any-object names, then one entry per handle
 * object and raw-execution name.
 */
export const dataAccessMembers = [
  ...dataNames.map((property) => ({ message: dataMessage, property })),
  ...handleObjects.flatMap((object) =>
    rawNames.map((property) => ({ message: dataMessage, object, property })),
  ),
];
