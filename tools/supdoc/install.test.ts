import { describe, expect, test } from "bun:test";
import { parsePin, verifyDigest } from "./install.ts";

const digest = "a".repeat(64);

describe("parsePin", () => {
  test("parses the tag and one entry per target", () => {
    const pin = parsePin(
      `tag v0.4.0\naarch64-apple-darwin ${digest} supdoc-0.4.0-aarch64-apple-darwin.tar.gz\n`,
    );

    expect(pin.tag).toBe("v0.4.0");
    expect(pin.targets.get("aarch64-apple-darwin")).toEqual({
      assetFile: "supdoc-0.4.0-aarch64-apple-darwin.tar.gz",
      sha256: digest,
    });
  });

  test("throws naming the line and the missing asset file", () => {
    expect(() => parsePin(`tag v0.4.0\naarch64-apple-darwin ${digest}\n`)).toThrow(
      /line 2: missing field asset-file/u,
    );
  });

  test("throws when there is no tag line", () => {
    expect(() => parsePin(`aarch64-apple-darwin ${digest} supdoc.tar.gz\n`)).toThrow(
      /line 1: missing field "tag"/u,
    );
  });
});

describe("verifyDigest", () => {
  const bytes = new TextEncoder().encode("supdoc");
  const expected = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  test("returns on a match", () => {
    expect(() => {
      verifyDigest(bytes, expected);
    }).not.toThrow();
  });

  test("throws on a mismatch", () => {
    expect(() => {
      verifyDigest(bytes, digest);
    }).toThrow(/digest mismatch/u);
  });
});
