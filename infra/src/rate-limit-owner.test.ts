import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  ForeignRateLimitRules,
  RateLimitEntrypoint,
  guardRateLimitOwner,
  rateLimitRef,
} from "./rate-limit-owner.ts";
import type { EntrypointRule } from "./rate-limit-owner.ts";
import { zoneNameCandidates } from "./rate-limit-owner-live.ts";

const ref = rateLimitRef("app", "prod");

const zone = { id: "zone-1", name: "example.test" };

/**
 * Run the guard against a fake entrypoint holding `rules`.
 */
const guard = (rules: ReadonlyArray<EntrypointRule>) =>
  guardRateLimitOwner("app.example.test", ref).pipe(
    Effect.provide(
      Layer.succeed(RateLimitEntrypoint, {
        read: () => Effect.succeed({ rules, zone }),
      }),
    ),
  );

describe("guardRateLimitOwner", () => {
  it.effect("passes an empty entrypoint", () => guard([]));

  it.effect("passes the stack's own rule", () => guard([{ id: "own-1", ref }]));

  it.effect("refuses one foreign rule, naming the zone and the id", () =>
    Effect.gen(function* foreign() {
      const failure = yield* Effect.flip(guard([{ id: "dash-1", ref: undefined }]));

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.deepStrictEqual(
        failure,
        new ForeignRateLimitRules({ ruleIds: ["dash-1"], zone: "example.test (zone-1)" }),
      );
      assert.include(failure.message, "example.test (zone-1)");
      assert.include(failure.message, "dash-1");
    }),
  );

  it.effect("names only the foreign rules of a mixed entrypoint", () =>
    Effect.gen(function* mixed() {
      const failure = yield* Effect.flip(
        guard([
          { id: "other-1", ref: "another-stack-ratelimit" },
          { id: "own-1", ref },
          { id: "dash-2", ref: undefined },
        ]),
      );

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.deepStrictEqual(failure.ruleIds, ["other-1", "dash-2"]);
      assert.notInclude(failure.message, "own-1");
    }),
  );
});

describe("zoneNameCandidates", () => {
  it("lists the hostname, then each parent with two labels or more", () => {
    assert.deepStrictEqual(zoneNameCandidates("a.b.example.test"), [
      "a.b.example.test",
      "b.example.test",
      "example.test",
    ]);
    assert.deepStrictEqual(zoneNameCandidates("example.test"), ["example.test"]);
  });
});
