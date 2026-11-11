import { Option, Schema } from "effect";
import { flow } from "effect/Function";

/**
 * The OAuth callback error codes Better Auth 1.7.19 redirects with, and the two this page adds
 * (`access_denied`, `account_not_linked`). Every other value is unknown.
 */
const OAuthErrorCode = Schema.Literals([
  "access_denied",
  "account_already_linked_to_different_user",
  "account_not_linked",
  "email_does_not_match",
  "email_not_found",
  "email_not_verified",
  "invalid_callback_request",
  "invalid_code",
  "issuer_mismatch",
  "issuer_missing",
  "no_callback_url",
  "no_code",
  "nonce_binding_missing",
  "oauth_provider_not_found",
  "state_mismatch",
  "state_not_found",
  "unable_to_get_user_info",
  "unable_to_link_account",
]);

type OAuthErrorCodeValue = typeof OAuthErrorCode.Type;

/**
 * The line shown when there is no allowlisted code, and for the codes that mean the sign-in did
 * not finish.
 */
const GENERIC_COPY = "Sign-in didn't finish. Try again.";

/**
 * The line of the codes that mean the sign-in started in another tab or took too long.
 */
const EXPIRED_COPY =
  "The sign-in took too long or started in another tab. Start again from the sign-in page.";

/**
 * The copy of each allowlisted code. This is the only home of OAuth error copy.
 */
const CODE_COPY: Readonly<Record<OAuthErrorCodeValue, string>> = {
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  account_already_linked_to_different_user:
    "That GitHub or Google account is already linked to another user. Sign in to that user first, then unlink it in Settings.",
  account_not_linked:
    "An account with this email already exists. Sign in with your password, then link GitHub in Settings.",
  email_does_not_match:
    "The email on that account doesn't match this one. Sign in with the account that owns it.",
  email_not_found:
    "The provider returned no email address. Allow email access on the provider, then try again.",
  email_not_verified:
    "The provider hasn't verified that email. Verify it with the provider, then try again.",
  invalid_callback_request: GENERIC_COPY,
  invalid_code: GENERIC_COPY,
  issuer_mismatch: GENERIC_COPY,
  issuer_missing: GENERIC_COPY,
  no_callback_url: GENERIC_COPY,
  no_code: GENERIC_COPY,
  nonce_binding_missing: GENERIC_COPY,
  oauth_provider_not_found: "That sign-in method isn't enabled here. Sign in with your password.",
  state_mismatch: EXPIRED_COPY,
  state_not_found: EXPIRED_COPY,
  unable_to_get_user_info: GENERIC_COPY,
  unable_to_link_account:
    "The account couldn't be linked. Sign in with your password, then link it in Settings.",
};

/**
 * Every allowlisted code, for the test that compares it with Better Auth's.
 */
export const OAUTH_ERROR_CODES: ReadonlyArray<string> = Object.keys(CODE_COPY);

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
