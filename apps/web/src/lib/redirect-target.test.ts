import { describe, expect, it } from "@effect/vitest";
import { validateRedirectSearch } from "./redirect-target.ts";

describe("validateRedirectSearch", () => {
  it("keeps a root-relative path with its search", () => {
    expect(validateRedirectSearch({ redirect: "/notes?q=1" })).toEqual({ redirect: "/notes?q=1" });
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "notes", "", 3, undefined])(
    "leaves out %j",
    (value) => {
      expect(validateRedirectSearch({ redirect: value })).toEqual({ redirect: undefined });
    },
  );
});
