import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RateLimitEntrypointError } from "./rate-limit-owner.ts";
import { readZoneEntrypoint } from "./rate-limit-owner-live.ts";

const zone = { id: "zone-1", name: "example.test" };

describe("readZoneEntrypoint", () => {
  it.effect("fails when no zone of the account holds the hostname, naming the variable", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(
        readZoneEntrypoint(
          {
            findZone: () => Effect.succeedNone,
            readRules: () => Effect.succeed([]),
          },
          "app.other.test",
          "STAGES_TEST_CUSTOM_DOMAIN",
        ),
      );

      assert.instanceOf(failure, RateLimitEntrypointError);
      assert.include(failure.message, "app.other.test");
      assert.include(failure.message, "STAGES_TEST_CUSTOM_DOMAIN");
      assert.include(failure.message, "Zone WAF Read");
    }),
  );

  it.effect("returns the zone with its rules", () =>
    Effect.gen(function* found() {
      const entrypoint = yield* readZoneEntrypoint(
        {
          findZone: () => Effect.succeedSome(zone),
          readRules: () => Effect.succeed([{ id: "r1", ref: undefined }]),
        },
        "app.example.test",
        "CUSTOM_DOMAIN",
      );

      assert.deepStrictEqual(entrypoint, { rules: [{ id: "r1", ref: undefined }], zone });
    }),
  );
});
