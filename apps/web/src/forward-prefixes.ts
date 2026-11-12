/**
 * The paths `web` forwards to its service bindings: a pattern ending in `/*` is a prefix, any other
 * pattern is one exact path.
 *
 * A leaf module with no imports: `infra/src/web.ts` value-imports it for `assets.runWorkerFirst`
 * and `apps/web/src/server.ts` for the forward, so both read one constant while the env type
 * import stays type-only. `/llms.txt` is the one exact path: it sits outside `/api` and `api`
 * serves it; `forward.test.ts` pins it to `LLMS_PATH` of the contract.
 */
export const FORWARD_PREFIXES = ["/api/*", "/auth/*", "/llms.txt"] as const;
