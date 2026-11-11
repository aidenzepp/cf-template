import { describe, expect, it } from "@effect/vitest";
import { isAuthScreen, isSessionLess } from "./session-less-paths.ts";

describe("isSessionLess", () => {
  it("matches /unavailable", () => {
    expect(isSessionLess("/unavailable")).toBeTruthy();
  });

  it.each(["/unavailable/", "/unavailable2", "/", "/other", "/Unavailable", ""])(
    "does not match %j",
    (pathname) => {
      expect(isSessionLess(pathname)).toBeFalsy();
    },
  );
});

describe("isAuthScreen", () => {
  it.each(["/sign-in", "/sign-up", "/oauth-error"])("matches %s", (pathname) => {
    expect(isAuthScreen(pathname)).toBeTruthy();
  });

  it.each(["/sign-in/", "/sign-in2", "/", "/other"])("does not match %j", (pathname) => {
    expect(isAuthScreen(pathname)).toBeFalsy();
  });
});
