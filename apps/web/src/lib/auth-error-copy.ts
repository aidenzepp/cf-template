/**
 * What a call site knows about a failed auth call: the client's `error`, or `{ status: 0 }` for a
 * promise that rejected before any response arrived.
 */
export interface AuthErrorInput {
  readonly aborted: boolean;
  readonly error: {
    readonly status: number;
    readonly code?: string | undefined;
    readonly message?: string | undefined;
  } | null;
}

/**
 * The copy of each Better Auth error code the screens handle. This file is the only home of auth
 * copy.
 */
const CODE_COPY = {
  ACCOUNT_NOT_FOUND: "That account isn't linked anymore. Reload the page.",
  AUTH_CANCELLED: "The passkey sign-in didn't finish. Try again, or use your email and password.",
  ERROR_CEREMONY_ABORTED:
    "The passkey sign-in didn't finish. Try again, or use your email and password.",
  FAILED_TO_UNLINK_LAST_ACCOUNT:
    "That is your only way to sign in. Add another one before you remove it.",
  FAILED_TO_UPDATE_PASSKEY: "The passkey couldn't be renamed. Try again.",
  FAILED_TO_VERIFY_REGISTRATION: "The passkey couldn't be added. Try again.",
  INVALID_EMAIL_OR_PASSWORD: "Wrong email or password.",
  INVALID_PASSWORD: "That password is wrong.",
  PASSKEY_NOT_FOUND: "That passkey is gone. Reload the page.",
  PASSWORD_TOO_LONG: "Use a shorter password.",
  PASSWORD_TOO_SHORT: "Use a longer password.",
  SESSION_EXPIRED: "Your session ended. Sign in again.",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "That account is already linked. Unlink it first, then try again.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
} as const satisfies Record<string, string>;

const copyByCode = new Map<string, string>(Object.entries(CODE_COPY));

/**
 * Turn a failed auth call into the line a person reads.
 *
 * An aborted request shows nothing. A status of 0 means no response arrived. Better Auth's
 * `message` is never shown: text comes from this file only.
 *
 * @param input - Whether the request was aborted, and the client's error.
 * @param input.aborted - The route unmounted or its signal fired.
 * @param input.error - The client's `error`, or `null` for a success.
 * @returns The line to show, or `null` when nothing should show.
 */
export const authErrorCopy = ({ aborted, error }: AuthErrorInput): string | null => {
  if (aborted || error === null) {
    return null;
  }

  if (error.status === 0) {
    return "We couldn't reach the server. Check your connection and try again.";
  }

  if (error.status === 429) {
    return "Too many attempts. Try again in a little while.";
  }

  if (error.status >= 500) {
    return "The server had a problem. Try again.";
  }

  return copyByCode.get(error.code ?? "") ?? "Something went wrong. Try again.";
};
