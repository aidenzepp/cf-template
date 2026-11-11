import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { CustomDomain, Hostname, PublicOrigin, WEB_DEV_PORT } from "./public-origin.ts";

describe("Hostname", () => {
  it.effect.each(["example.com", "a-b.example.co.uk", "a", "1.example.com"])("accepts %s", (raw) =>
    Effect.gen(function* accepts() {
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(Schema.decodeUnknownEffect(Hostname)(raw))));
    }),
  );

  it.effect.each([
    "-a.example.com",
    "a-.example.com",
    "a..b",
    "a.",
    "",
    "Example.com",
    "https://example.com",
    `${"a".repeat(64)}.example.com`,
    Array.from({ length: 64 }, () => "abc").join("."),
  ])("rejects %s", (raw) =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(Hostname)(raw))));
    }),
  );
});

describe("CustomDomain", () => {
  it.effect.each(["workers-dev", "example.com"])("accepts %s", (raw) =>
    Effect.gen(function* accepts() {
      assert.isTrue(
        Exit.isSuccess(yield* Effect.exit(Schema.decodeUnknownEffect(CustomDomain)(raw))),
      );
    }),
  );
});

const decode = (raw: string) => Effect.exit(Schema.decodeUnknownEffect(PublicOrigin)(raw));

describe("PublicOrigin", () => {
  it.effect.each(["https://app.example.test", `http://localhost:${WEB_DEV_PORT}`])(
    "accepts %s",
    (raw) =>
      Effect.gen(function* accepts() {
        assert.isTrue(Exit.isSuccess(yield* decode(raw)));
      }),
  );

  it.effect.each(["https://app.example.test/auth", "app.example.test", "ftp://x.test", ""])(
    "rejects %s",
    (raw) =>
      Effect.gen(function* rejects() {
        assert.isTrue(Exit.isFailure(yield* decode(raw)));
      }),
  );
});
