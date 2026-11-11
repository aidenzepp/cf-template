import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger, Option } from "effect";
import type { LogLevel } from "effect";
import { LiveKnobs, fromSource } from "./knob.ts";
import { CloudflarePlanKnob } from "./plan.ts";
import { LogLevelKnob, atLogLevel, liveLogLevel } from "./log-level.ts";

/**
 * Log an `Info` and a `Warn` line inside a request run at the live level, and return the levels
 * that reached the logger, in order.
 *
 * @param live - What the live source holds under `LOG_LEVEL`, or `undefined` for the default port.
 */
const levelsLogged = (live: string | undefined) =>
  Effect.gen(function* collect() {
    const seen: Array<LogLevel.LogLevel> = [];

    const logger = Logger.make(({ logLevel }) => {
      seen.push(logLevel);
    });

    const level = yield* liveLogLevel.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );

    yield* atLogLevel(level)(
      Effect.logInfo("handled").pipe(Effect.andThen(Effect.logWarning("slow"))),
    ).pipe(Effect.provide(Logger.layer([logger])));

    return seen;
  }).pipe(
    Effect.provideService(
      LiveKnobs,
      live === undefined
        ? LiveKnobs.defaultValue()
        : fromSource({ name: "test", read: () => Effect.succeed(Option.some(live)) }),
    ),
  );

describe("LOG_LEVEL through the LiveKnobs port", () => {
  it.effect("drops an Info log and keeps a Warn log while the live value is Warn", () =>
    Effect.gen(function* warn() {
      assert.deepStrictEqual(yield* levelsLogged("Warn"), ["Warn"]);
    }),
  );

  it.effect("keeps both logs at the tier (b) level Info with the default port", () =>
    Effect.gen(function* info() {
      assert.deepStrictEqual(yield* levelsLogged(undefined), ["Info", "Warn"]);
    }),
  );

  it.effect("keeps the tier (b) level for a live value its schema rejects", () =>
    Effect.gen(function* rejected() {
      const seen = yield* levelsLogged("not-a-level");

      assert.deepStrictEqual(seen.slice(-2), ["Info", "Warn"]);
    }),
  );
});

describe("knob string codec", () => {
  it.effect("round-trips the LogLevelKnob default", () =>
    Effect.gen(function* roundTrip() {
      const raw = yield* LogLevelKnob.encode(LogLevelKnob.default);

      assert.strictEqual(raw, "Info");
      assert.strictEqual(yield* LogLevelKnob.decode(raw), LogLevelKnob.default);
    }),
  );

  it.effect("round-trips the CloudflarePlanKnob default", () =>
    Effect.gen(function* roundTrip() {
      const raw = yield* CloudflarePlanKnob.encode(CloudflarePlanKnob.default);

      assert.strictEqual(raw, "paid");
      assert.strictEqual(yield* CloudflarePlanKnob.decode(raw), CloudflarePlanKnob.default);
    }),
  );
});
