import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { PublicOrigin, WEB_DEV_PORT } from "./public-origin.ts";

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
