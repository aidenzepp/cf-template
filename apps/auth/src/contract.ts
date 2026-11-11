import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy";
import type { MainRpc } from "alchemy/Platform";
import type { Effect } from "effect";
import type { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import type { Session } from "@workspace/contract/domain/session";

export { AUTH_BASE_PATH, OAUTH_ERROR_PATH } from "@workspace/contract/domain/auth-paths";

/**
 * The internal methods of the `auth` Worker's default entrypoint, called over its service binding
 * and unreachable over HTTP.
 */
export interface AuthEntrypoint extends MainRpc<RuntimeContext> {
  /**
   * Resolve the session a request's own `Cookie` header carries.
   *
   * The result is `null` when the request is signed out and nothing else. A store fault fails with
   * `AuthUnavailable`, never `null`. The method reads the signed cookie cache and never refreshes
   * the session, so the caller sends no `Set-Cookie` back. `RuntimeContext` is the host's per-call
   * context, which Alchemy provides to every handler; no caller supplies it.
   */
  readonly checkSession: (input: {
    readonly cookie: string;
  }) => Effect.Effect<Session | null, AuthUnavailable, RuntimeContext>;
}

/**
 * The `auth` Worker's tag: its name and the {@link AuthEntrypoint} callers bind. Every other app
 * imports this module as `@workspace/auth/contract` and nothing else of `auth`.
 */
export class Auth extends Cloudflare.Worker<Auth, AuthEntrypoint>()("Auth") {}
