import { Schema } from "effect";
import { HttpApiError } from "effect/http-api";

/**
 * The request carries no valid session.
 */
export class SessionRequired extends HttpApiError.Problem<SessionRequired>()("SessionRequired", {
  status: 401,
  title: "Sign-in required",
  type: "/problems/session-required",
}) {}

/**
 * The sign-in service could not be reached to check the session.
 */
export class AuthUnavailable extends HttpApiError.Problem<AuthUnavailable>()(
  "AuthUnavailable",
  { status: 503, title: "Sign-in service unavailable", type: "/problems/auth-unavailable" },
  { retryAfterSeconds: Schema.Int },
) {}
