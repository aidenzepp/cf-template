import { BunCrypto } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Digest } from "effect/crypto";
import { parsePin, verifyDigest } from "./install.ts";

const digest = "a".repeat(64);

describe("parsePin", () => {
  it.effect("parses the tag and one entry per target", () =>
    Effect.gen(function* case1() {
      const pin = yield* parsePin(
        `tag v0.4.0\naarch64-apple-darwin ${digest} supdoc-0.4.0-aarch64-apple-darwin.tar.gz\n`,
      );

      assert.strictEqual(pin.tag, "v0.4.0");
      assert.deepStrictEqual(pin.targets.get("aarch64-apple-darwin"), {
        assetFile: "supdoc-0.4.0-aarch64-apple-darwin.tar.gz",
        sha256: digest,
      });
    }),
  );

  it.effect("rejects a line missing a group, naming the line and the asset file", () =>
    Effect.gen(function* case2() {
      const error = yield* Effect.flip(parsePin(`tag v0.4.0\naarch64-apple-darwin ${digest}\n`));

      assert.strictEqual(error._tag, "PinError");
      assert.match(error.message, /line 2: missing field asset-file/u);
    }),
  );

  it.effect("rejects a text with no tag line", () =>
    Effect.gen(function* case3() {
      const error = yield* Effect.flip(parsePin(`aarch64-apple-darwin ${digest} supdoc.tar.gz\n`));

      assert.strictEqual(error._tag, "PinError");
      assert.match(error.message, /line 1: missing field "tag"/u);
    }),
  );
});

describe("verifyDigest", () => {
  const bytes = new TextEncoder().encode("supdoc");

  it.effect("accepts a matching digest", () =>
    Effect.gen(function* case4() {
      const expected = yield* Digest.Digest.use((service) =>
        service.digestHex(Digest.sha256, bytes),
      );

      yield* verifyDigest(bytes, expected);
    }).pipe(Effect.provide(BunCrypto.layerDigest)),
  );

  it.effect("rejects a mismatched digest", () =>
    Effect.gen(function* case5() {
      const error = yield* Effect.flip(verifyDigest(bytes, digest, "supdoc.tar.gz"));

      assert.strictEqual(error._tag, "DigestMismatch");
      assert.match(
        error.message,
        /^supdoc: digest mismatch for supdoc\.tar\.gz: expected a{64}, got [0-9a-f]{64}; the archive is refused\.$/u,
      );
    }).pipe(Effect.provide(BunCrypto.layerDigest)),
  );
});
