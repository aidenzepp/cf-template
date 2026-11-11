import { describe, expect, it } from "@effect/vitest";
import { authErrorCopy } from "./auth-error-copy.ts";

const failed = (error: { status: number; code?: string; message?: string }) =>
  authErrorCopy({ aborted: false, error });

describe("authErrorCopy", () => {
  it("shows nothing for an aborted request", () => {
    expect(authErrorCopy({ aborted: true, error: { status: 0 } })).toBeNull();
  });

  it("shows nothing for a success", () => {
    expect(authErrorCopy({ aborted: false, error: null })).toBeNull();
  });

  it("explains a promise that rejected without a response", () => {
    expect(failed({ status: 0 })).toBe(
      "We couldn't reach the server. Check your connection and try again.",
    );
  });

  it("explains a 429", () => {
    expect(failed({ code: "RATE_LIMITED", status: 429 })).toBe(
      "Too many attempts. Try again in a little while.",
    );
  });

  it("never shows the message of a 500", () => {
    const line = failed({ message: "SQLITE_ERROR secret", status: 500 });

    expect(line).toBe("The server had a problem. Try again.");
  });

  it.each([
    ["INVALID_EMAIL_OR_PASSWORD", "Wrong email or password."],
    ["USER_ALREADY_EXISTS", "An account with this email already exists. Sign in instead."],
    ["PASSWORD_TOO_SHORT", "Use a longer password."],
  ])("keys %s to its line", (code, line) => {
    expect(failed({ code, message: "raw", status: 400 })).toBe(line);
  });

  it("uses one generic line for an unknown code or none", () => {
    expect(failed({ code: "NOPE", message: "raw", status: 400 })).toBe(
      "Something went wrong. Try again.",
    );
    expect(failed({ status: 400 })).toBe("Something went wrong. Try again.");
  });
});
