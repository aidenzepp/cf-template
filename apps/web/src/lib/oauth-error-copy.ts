import { Option, Schema } from "effect";
import { flow } from "effect/Function";

/**
 * The OAuth callback error codes Better Auth 1.7.19 redirects with that this page has copy for.
 * Every other value is unknown.
 */
const OAuthErrorCode = Schema.Literals([
  "access_denied",
  "account_already_linked_to_different_user",
  "email_does_not_match",
  "email_not_found",
  "email_not_verified",
  "invalid_callback_request",
  "state_mismatch",
  "state_not_found",
]);

type OAuthErrorCodeValue = typeof OAuthErrorCode.Type;

/**
 * The line shown when there is no allowlisted code.
 */
const GENERIC_COPY =
  "Sign-in with that account didn't work. Try again, or use another way to sign in.";

/**
 * The copy of each allowlisted code. This is the only home of OAuth error copy.
 */
const CODE_COPY: Readonly<Record<OAuthErrorCodeValue, string>> = {
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  account_already_linked_to_different_user:
    "That account is already linked to a different user. Sign in with it instead.",
  email_does_not_match: "That account's email does not match yours, so it was not linked.",
  email_not_found: "That account did not share an email address, so we could not sign you in.",
  email_not_verified: "That account's email is not verified, so we could not sign you in.",
  invalid_callback_request: "That sign-in link is not valid. Start again from the sign-in page.",
  state_mismatch: "That sign-in attempt expired or came from somewhere else. Start again.",
  state_not_found: "That sign-in attempt expired. Start again.",
};

const decodeCode = Schema.decodeUnknownOption(OAuthErrorCode);

/**
 * Reduce the raw `error` query value of `/oauth-error` to an allowlisted code. Anything else,
 * including `error_description`, is dropped so it never enters router state or the page.
 *
 * Takes the raw `error` query value and returns the code when it is allowlisted, otherwise
 * `undefined`.
 */
export const oauthErrorCode = flow(decodeCode, Option.getOrUndefined);

/**
 * The line a person reads for a code from {@link oauthErrorCode}.
 *
 * @param code - An allowlisted code, or `undefined`.
 * @returns The fixed copy for the code, otherwise one generic line.
 */
export const oauthErrorCopy = (code: OAuthErrorCodeValue | undefined): string =>
  code === undefined ? GENERIC_COPY : CODE_COPY[code];
