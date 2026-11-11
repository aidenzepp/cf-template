import { createAuthMiddleware, freshSessionMiddleware } from "better-auth/api";

/**
 * The account-changing endpoints that require a fresh session, relative to `AUTH_BASE_PATH` as
 * `ENDPOINT_CLASSES` spells them.
 *
 * Better Auth gates `/unlink-account` and `/passkey/verify-registration` itself, so they are not
 * listed. `/update-user` is gated by Better Auth only for some bodies, and the others are not
 * gated at all.
 */
export const FRESH_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/link-social",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/update-user",
]);

/**
 * The `hooks.before` middleware that refuses a stale session on {@link FRESH_SESSION_PATHS}.
 *
 * It runs Better Auth's own `freshSessionMiddleware` (better-auth `1.7.19`,
 * `dist/api/routes/session.mjs`), so a stale session gets exactly the refusal the gated endpoints
 * give: `403 FORBIDDEN` with `SESSION_NOT_FRESH`, judged against the configured `session.freshAge`
 * (a `freshAge` of `0` disables the check) and a missing session gets `401 UNAUTHORIZED`.
 *
 * @returns The middleware to compose into `hooks.before`.
 */
export const requireFreshSession = createAuthMiddleware(async (ctx) => {
  if (FRESH_SESSION_PATHS.has(ctx.path)) {
    await freshSessionMiddleware(ctx);
  }
});
