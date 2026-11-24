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
const jsonStringifyMember = {
  message:
    "encode with a Schema (Schema.fromJsonString), and log through Effect.annotateLogs (docs/capabilities.md, JSON encoding)",
  object: "JSON",
  property: "stringify",
};

/**
 * The registry-owned entries every source list carries; tests and tools lift them.
 */
export const registryMembers = [...authFetchMembers, jsonStringifyMember];
