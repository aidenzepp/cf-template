/**
 * The path prefixes `web` forwards to its service bindings.
 *
 * A leaf module with no imports: `infra/src/web.ts` value-imports it for `assets.runWorkerFirst`
 * and `apps/web/src/server.ts` for the forward, so both read one constant while the env type
 * import stays type-only.
 */
export const FORWARD_PREFIXES = ["/api/*", "/auth/*"] as const;
