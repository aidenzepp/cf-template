import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Knob } from "@workspace/config/knob";
import { KNOB_REFRESH_MS, makeKnobsPort } from "./live.ts";

const Mode = Schema.Literals(["fast", "slow"]).annotate({
  default: "fast",
  description: "How fast the test subject runs.",
});

const ModeKnob = Knob.make("MODE", Mode);

/**
 * A store that counts its reads and answers each with the next of `answers`: a string, `null`, or
 * `"fail"` for a failed read.
 */
const storeOf = (...answers: ReadonlyArray<string | null>) => {
  const reads: Array<string> = [];

  const read = (key: string): Effect.Effect<string | null, string> =>
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const answer = answers[Math.min(reads.length, answers.length - 1)] ?? null;

          reads.push(key);

          return answer === "fail" ? Effect.fail("unreachable") : Effect.succeed(answer);
        }),
      ),
    );

  return { read, reads };
};

/**
 * Bind `MODE` on a port over `read`, with an empty tier (b) environment and every log line's
 * level and message collected.
 */
const bound = (read: (key: string) => Effect.Effect<string | null, string>) =>
  Effect.gen(function* bindMode() {
    const lines: Array<string> = [];

    const logger = Logger.make(({ logLevel, message }) => {
      lines.push(`${logLevel}:${String(message)}`);
    });

    const reader = yield* makeKnobsPort(read)
      .bind(ModeKnob)
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Logger.layer([logger]),
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          ),
        ),
      );

    return { lines, reader: reader.pipe(Effect.provide(Logger.layer([logger]))) };
  });

describe("makeKnobsPort", () => {
  it.effect("reads a key once per refresh interval and then again", () =>
    Effect.gen(function* refresh() {
      const store = storeOf("slow");
      const { reader } = yield* bound(store.read);

      assert.strictEqual(yield* reader, "slow");
      assert.strictEqual(yield* reader, "slow");
      assert.strictEqual(store.reads.length, 1);

      yield* TestClock.adjust(KNOB_REFRESH_MS);
      yield* reader;

      assert.strictEqual(store.reads.length, 2);
    }),
  );

  it.effect("caches a failed read and retries it after the interval", () =>
    Effect.gen(function* failing() {
      const store = storeOf("fail", "slow");
      const { reader } = yield* bound(store.read);

      assert.strictEqual(yield* reader, "fast");
      assert.strictEqual(yield* reader, "fast");
      assert.strictEqual(store.reads.length, 1);

      yield* TestClock.adjust(KNOB_REFRESH_MS);

      assert.strictEqual(yield* reader, "slow");
    }),
  );

  it.effect("logs knob.live.rejected once per key and falls back to tier (b)", () =>
    Effect.gen(function* rejection() {
      const store = storeOf("not-a-mode");
      const { lines, reader } = yield* bound(store.read);

      assert.strictEqual(yield* reader, "fast");
      yield* TestClock.adjust(KNOB_REFRESH_MS);
      assert.strictEqual(yield* reader, "fast");
      assert.deepStrictEqual(
        lines.filter((line) => line.endsWith("knob.live.rejected")),
        ["Error:knob.live.rejected"],
      );
    }),
  );

  it.effect("does not share an in-flight read between requests", () =>
    Effect.gen(function* concurrent() {
      const store = storeOf("slow");
      const { reader } = yield* bound(store.read);

      yield* Effect.all([reader, reader], { concurrency: "unbounded" });

      assert.strictEqual(store.reads.length, 2);
    }),
  );

  it.effect("treats an absent key as tier (b)", () =>
    Effect.gen(function* absent() {
      const { reader } = yield* bound(storeOf(null).read);

      assert.strictEqual(yield* reader, "fast");
    }),
  );
});
