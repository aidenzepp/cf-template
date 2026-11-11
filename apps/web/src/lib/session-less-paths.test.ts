import { describe, expect, it } from "@effect/vitest";
import { isAuthScreen, isSessionLess } from "./session-less-paths.ts";

describe("isSessionLess", () => {
  it("matches /unavailable", () => {
    expect(isSessionLess("/unavailable")).toBe(true);
  });

  it.each(["/unavailable/", "/unavailable2", "/", "/notes", "/Unavailable", ""])(
    "does not match %j",
    (pathname) => {
      expect(isSessionLess(pathname)).toBe(false);
    },
  );
});

describe("isAuthScreen", () => {
  it.each(["/sign-in", "/sign-up", "/oauth-error"])("matches %s", (pathname) => {
    expect(isAuthScreen(pathname)).toBe(true);
  });

  it.each(["/sign-in/", "/sign-in2", "/", "/notes"])("does not match %j", (pathname) => {
    expect(isAuthScreen(pathname)).toBe(false);
  });
});
