import { Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * How long, in milliseconds, `api` waits for `auth` to answer a session check before it answers
 * 503 `AuthUnavailable`. It is the only timeout on the request path.
 */
export const AuthCheckSessionTimeoutKnob = Knob.make(
  "AUTH_CHECK_SESSION_TIMEOUT_MS",
  Schema.Int.annotate({
    default: 1500,
    description: "Milliseconds api waits for auth to check a session before it answers 503.",
  }),
);

/**
 * Whether a 400 Problem Details body lists the issues of the failed request decode. Off on `prod`,
 * where the body carries only the generic detail.
 */
export const ProblemDetailsIncludeKnob = Knob.make(
  "PROBLEM_DETAILS_INCLUDE",
  Schema.Boolean.annotate({
    default: false,
    description: "Whether a 400 problem body lists the validation issues of the request.",
  }),
);

/**
 * The seconds a caller waits before retrying after `auth` could not be reached; the value of
 * `retryAfterSeconds` in the problem body and of the `Retry-After` header.
 */
export const AUTH_UNAVAILABLE_RETRY_AFTER_S = 5;
