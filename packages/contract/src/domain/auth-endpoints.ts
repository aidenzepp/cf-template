import { AUTH_BASE_PATH } from "./auth-paths.ts";

/**
 * How the rate limiter treats an endpoint: `credential` endpoints hash or verify a password and
 * take the strict class, every other endpoint is `public`.
 */
export type EndpointClass = "credential" | "public";

/**
 * The class of every HTTP endpoint Better Auth registers, keyed by the path it registers, relative
 * to {@link AUTH_BASE_PATH}. `endpoints.test.ts` fails when an endpoint is registered that this
 * table does not name, so a new endpoint is reviewed before it is forwarded.
 *
 * `/delete-user` is `credential` because it verifies a password when the body carries one
 * (better-auth 1.7.19, `dist/api/routes/update-user.mjs:288-294`). `/reset-password` hashes the new
 * password.
 */
export const ENDPOINT_CLASSES = {
  "/account-info": "public",
  "/callback/:id": "public",
  "/change-email": "public",
  "/change-password": "credential",
  "/delete-user": "credential",
  "/delete-user/callback": "public",
  "/error": "public",
  "/get-access-token": "public",
  "/get-session": "public",
  "/link-social": "public",
  "/list-accounts": "public",
  "/list-sessions": "public",
  "/ok": "public",
  "/passkey/delete-passkey": "public",
  "/passkey/generate-authenticate-options": "public",
  "/passkey/generate-register-options": "public",
  "/passkey/list-user-passkeys": "public",
  "/passkey/update-passkey": "public",
  "/passkey/verify-authentication": "public",
  "/passkey/verify-registration": "public",
  "/refresh-token": "public",
  "/request-password-reset": "public",
  "/reset-password": "credential",
  "/reset-password/:token": "public",
  "/revoke-other-sessions": "public",
  "/revoke-session": "public",
  "/revoke-sessions": "public",
  "/send-verification-email": "public",
  "/sign-in/email": "credential",
  "/sign-in/social": "public",
  "/sign-out": "public",
  "/sign-up/email": "credential",
  "/unlink-account": "public",
  "/update-session": "public",
  "/update-user": "public",
  "/verify-email": "public",
  "/verify-password": "credential",
} as const satisfies Record<string, EndpointClass>;

/**
 * The registered paths of the `credential` class, relative to {@link AUTH_BASE_PATH}: the paths the
 * credential rate limit applies to.
 */
export const CREDENTIAL_PATHS: ReadonlyArray<string> = Object.entries(ENDPOINT_CLASSES).flatMap(
  ([path, endpointClass]) => (endpointClass === "credential" ? [path] : []),
);

/**
 * The credential paths as the browser requests them: each of {@link CREDENTIAL_PATHS} under
 * {@link AUTH_BASE_PATH}.
 */
export const CREDENTIAL_ROUTES: ReadonlyArray<string> = CREDENTIAL_PATHS.map(
  (path) => `${AUTH_BASE_PATH}${path}`,
);
