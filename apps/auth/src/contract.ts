import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy";
import type { MainRpc } from "alchemy/Platform";
import type { Effect } from "effect";
import type { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import type { Session } from "@workspace/contract/domain/session";

/**
 * The wire form of a session: the contract `Session` encoded, plain JSON values only.
 */
export type EncodedSession = typeof Session.Encoded;

export { AUTH_BASE_PATH, OAUTH_ERROR_PATH } from "@workspace/contract/domain/auth-paths";

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
export const CREDENTIAL_PATHS: readonly string[] = Object.entries(ENDPOINT_CLASSES).flatMap(
  ([path, endpointClass]) => (endpointClass === "credential" ? [path] : []),
);

/**
 * The internal methods of the `auth` Worker's default entrypoint, called over its service binding
 * and unreachable over HTTP.
 */
export interface AuthEntrypoint extends MainRpc<RuntimeContext> {
  /**
   * Resolve the session a request's own `Cookie` header carries.
   *
   * The result is the encoded session, or `null` when the request is signed out and nothing else. A
   * store fault fails with `AuthUnavailable`, never `null`. The method reads the signed cookie
   * cache and never refreshes the session, so the caller sends no `Set-Cookie` back.
   * `RuntimeContext` is the host's per-call context, which Alchemy provides to every handler; no
   * caller supplies it.
   */
  readonly checkSession: (input: {
    readonly cookie: string;
  }) => Effect.Effect<EncodedSession | null, AuthUnavailable, RuntimeContext>;
}

/**
 * The `auth` Worker's tag: its name and the {@link AuthEntrypoint} callers bind. Every other app
 * imports this module as `@workspace/auth/contract` and nothing else of `auth`.
 */
export class Auth extends Cloudflare.Worker<Auth, AuthEntrypoint>()("Auth") {}
