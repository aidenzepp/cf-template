import { createAuthMiddleware, freshSessionMiddleware } from "better-auth/api";

/**
 * The account-changing endpoints that this hook gates on a fresh session, relative to
 * `AUTH_BASE_PATH` as `ENDPOINT_CLASSES` spells them.
 *
 * Better Auth gates none of them: `/update-user` only needs a session, and `/revoke-*`,
 * `/change-email` and `/delete-user` need an authoritative session but not a fresh one
 * (better-auth `1.7.19`, `dist/api/routes/`). `/change-email` and `/delete-user` are disabled
 * today and gated anyway.
 */
export const FRESH_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/change-email",
  "/delete-user",
  "/link-social",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/update-user",
]);

/**
 * The endpoints Better Auth itself gates with `freshSessionMiddleware` (better-auth `1.7.19`:
 * `routes/account.mjs`, `routes/session.mjs`, and `@better-auth/passkey`), so the hook leaves them
 * alone.
 */
export const BETTER_AUTH_FRESH_PATHS: ReadonlySet<string> = new Set([
  "/list-sessions",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/unlink-account",
]);

/**
 * The endpoints that deliberately need no fresh session, each with the reason.
 */
export const EXEMPT_FROM_FRESHNESS = {
  "/account-info": "reads the caller's own account; changes nothing",
  "/callback/:id": "the provider callback that signs in; there is no earlier session",
  "/change-password": "requires the current password",
  "/delete-user/callback": "carries its own emailed token",
  "/error": "renders an error page",
  "/get-access-token": "reads or refreshes a provider token; changes no account setting",
  "/get-session": "reads the session",
  "/list-accounts": "read-only list",
  "/ok": "health check",
  "/passkey/generate-authenticate-options": "sign-in step; there is no session yet",
  "/passkey/list-user-passkeys": "read-only list",
  "/passkey/verify-authentication": "sign-in step; there is no session yet",
  "/refresh-token": "refreshes a provider token; changes no account setting",
  "/request-password-reset": "unauthenticated; sends a reset link",
  "/reset-password": "carries its own emailed token",
  "/reset-password/:token": "carries its own emailed token",
  "/send-verification-email": "sends a link to the address on file",
  "/sign-in/email": "creates the session",
  "/sign-in/social": "creates the session",
  "/sign-out": "ends the caller's own session",
  "/sign-up/email": "creates the account and its session",
  "/update-session": "changes only the current session's additional fields",
  "/verify-email": "carries its own emailed token",
  "/verify-password": "requires the current password",
} as const satisfies Readonly<Record<string, string>>;

/**
 * The `hooks.before` middleware that refuses a stale session on {@link FRESH_SESSION_PATHS}.
 *
 * It runs Better Auth's own `freshSessionMiddleware` (better-auth `1.7.19`,
 * `dist/api/routes/session.mjs`), so a stale session gets exactly the refusal the gated endpoints
 * give: `403 FORBIDDEN` with `SESSION_NOT_FRESH`, judged against the configured `session.freshAge`
 * (Better Auth's default of 86400 seconds here; `0` disables the check) and a missing session gets
 * `401 UNAUTHORIZED`.
 *
 * @returns The middleware to compose into `hooks.before`.
 */
export const requireFreshSession = createAuthMiddleware(async (ctx) => {
  if (FRESH_SESSION_PATHS.has(ctx.path)) {
    await freshSessionMiddleware(ctx);
  }
});
