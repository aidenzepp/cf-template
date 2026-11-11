import { Context } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import { AuthUnavailable, SessionRequired } from "../domain/auth-errors.ts";
import { NotesUnavailable } from "../domain/note-errors.ts";
import type { Session } from "../domain/session.ts";

/**
 * The session of the caller, provided to handlers by `SessionMiddleware`.
 */
export class CurrentUser extends Context.Service<CurrentUser, Session>()(
  "@workspace/contract/CurrentUser",
) {}

/**
 * Resolves the caller's session or fails; the implementation lives in `apps/api`.
 */
export class SessionMiddleware extends HttpApiMiddleware.Service<
  SessionMiddleware,
  { provides: CurrentUser }
>()("@workspace/contract/SessionMiddleware", {
  error: [SessionRequired, AuthUnavailable],
}) {}

/**
 * Fails with `NotesUnavailable` while the example feature is off; implemented in `apps/api`.
 */
export class ExampleFeatureGate extends HttpApiMiddleware.Service<ExampleFeatureGate>()(
  "@workspace/contract/ExampleFeatureGate",
  { error: NotesUnavailable },
) {}
