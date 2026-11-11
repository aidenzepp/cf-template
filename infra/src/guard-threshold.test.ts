import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Logger, Option } from "effect";
import { guardThreshold } from "./guard-threshold.ts";

const UNSET_LINE =
  "budget-guard: alert not declared (CPU_MS_PER_REQUEST or BYTES_PER_REQUEST unset)";

/**
 * Run the threshold effect over `values` as the whole environment, returning its result and every
 * log message it emitted.
 */
const run = (values: Readonly<Record<string, string>>) =>
  Effect.gen(function* collect() {
    const lines: Array<string> = [];

    const logger = Logger.make(({ message }) => {
      lines.push(String(message));
    });

    const threshold = yield* guardThreshold.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
      Effect.provide(Logger.layer([logger])),
    );

    return { lines, threshold };
  });

describe("guardThreshold", () => {
  it.effect("is 8333.33 per hour for 25 ms and 24000 bytes at the default multiple and share", () =>
    Effect.gen(function* both() {
      const { lines, threshold } = yield* run({
        BYTES_PER_REQUEST: "24000",
        CPU_MS_PER_REQUEST: "25",
      });

      // 10 x 0.5 x min(10_000_000, 30_000_000 / 25, 50 x 2^30 / 24000) / 720
      assert.isTrue(Option.isSome(threshold));
      assert.closeTo(Option.getOrThrow(threshold), 8333.333333, 0.000001);
      assert.deepStrictEqual(lines, []);
    }),
  );

  it.effect("follows the byte allowance when it is the tightest", () =>
    Effect.gen(function* bytes() {
      const { threshold } = yield* run({
        BYTES_PER_REQUEST: "10000000",
        CPU_MS_PER_REQUEST: "1",
        GUARD_MULTIPLE: "2",
      });

      // 2 x 0.5 x (50 x 2^30 / 10_000_000) / 720
      assert.closeTo(Option.getOrThrow(threshold), 7.45654016, 0.000001);
    }),
  );

  it.effect.each<{ readonly name: string; readonly values: Record<string, string> }>([
    { name: "CPU_MS_PER_REQUEST", values: { BYTES_PER_REQUEST: "24000" } },
    { name: "BYTES_PER_REQUEST", values: { CPU_MS_PER_REQUEST: "25" } },
    { name: "both", values: {} },
  ])("is none and logs one line when $name is unset", ({ values }) =>
    Effect.gen(function* unset() {
      const { lines, threshold } = yield* run(values);

      assert.isTrue(Option.isNone(threshold));
      assert.deepStrictEqual(lines, [UNSET_LINE]);
    }),
  );

  it.effect("fails on a supplied value that is not a positive number", () =>
    Effect.gen(function* invalid() {
      const exit = yield* Effect.exit(run({ BYTES_PER_REQUEST: "24000", CPU_MS_PER_REQUEST: "0" }));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
