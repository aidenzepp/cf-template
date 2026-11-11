import { expect, it } from "@effect/vitest";
import { oauthErrorCode, oauthErrorCopy } from "./oauth-error-copy.ts";

const GENERIC = "Sign-in didn't finish. Try again.";

it("maps an allowlisted code to its fixed copy", () => {
  expect(oauthErrorCopy(oauthErrorCode("access_denied"))).toBe(
    "Sign-in was cancelled. Try again when you are ready.",
  );
});

it("drops an unknown, inherited or non-string value to the generic line", () => {
  for (const value of ["nope", "constructor", "__proto__", "", undefined, 3, ["access_denied"]]) {
    expect(oauthErrorCode(value)).toBeUndefined();
    expect(oauthErrorCopy(oauthErrorCode(value))).toBe(GENERIC);
  }
});

it("never returns a crafted value", () => {
  const crafted = "<img src=x onerror=alert(1)> leak-token-0a1b2c3d4e5f";

  expect(oauthErrorCode(crafted)).toBeUndefined();
});
