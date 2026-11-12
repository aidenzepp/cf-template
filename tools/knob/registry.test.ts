import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Knob } from "../../packages/config/src/knob.ts";
import { liveKnobs } from "./registry.ts";

/**
 * Encode the default of `knob`, decode the result and return it with the default.
 */
const roundTrip = <A>(knob: Knob<A>) =>
  knob.encode(knob.default).pipe(
    Effect.flatMap(knob.decode),
    Effect.map((decoded) => ({ decoded, original: knob.default })),
  );

describe("liveKnobs", () => {
  it("holds exactly the three live knobs", () => {
    assert.deepStrictEqual(
      liveKnobs.map((knob) => knob.key),
      [
        "LOG_LEVEL",
        "API_DOCS_ENABLED",
        // block:notes start
        "EXAMPLE_FEATURE_ENABLED",
        // block:notes end
      ],
    );
  });

  it.effect("gives every entry a default that survives encode and decode", () =>
    Effect.gen(function* defaultRoundTrip() {
      // A tuple, so each entry keeps its own value type; the length above is the exhaustiveness check.
      const results = [
        yield* roundTrip(liveKnobs[0]),
        yield* roundTrip(liveKnobs[1]),
        // block:notes start
        yield* roundTrip(liveKnobs[2]),
        // block:notes end
      ];

      assert.lengthOf(results, liveKnobs.length);

      for (const { decoded, original } of results) {
        assert.isDefined(original);
        assert.deepStrictEqual(decoded, original);
      }
    }),
  );
});
