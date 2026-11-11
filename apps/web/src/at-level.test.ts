import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger, Option } from "effect";
import type { Config, Layer, LogLevel } from "effect";
import { LiveKnobs, fromSource } from "@workspace/config/knob";
import { atLevelLayer, atLiveLevel, unleveledLayer } from "./at-level.ts";
import type { AtLevel } from "./at-level.ts";

/**
 * Run an `Info` and a `Warn` log through {@link atLiveLevel} over a layer, and return the levels
 * that reached the logger.
 */
const levelsLogged = (layer: Layer.Layer<AtLevel, Config.ConfigError>) =>
  Effect.gen(function* collect() {
    const seen: Array<LogLevel.LogLevel> = [];

    const logger = Logger.make(({ logLevel }) => {
      seen.push(logLevel);
    });

    yield* atLiveLevel(
      Effect.logInfo("handled").pipe(Effect.andThen(Effect.logWarning("slow"))),
    ).pipe(Effect.provide(Logger.layer([logger])));

    return seen;
  }).pipe(Effect.provide(layer), Effect.orDie);

/**
 * Bindings that hold no `LOG_LEVEL`, so tier (b) is the default.
 */
const none = ConfigProvider.fromUnknown({});

describe("the live log level of web", () => {
  it.effect("drops an Info log and keeps a Warn log while the live value is Warn", () =>
    Effect.gen(function* warn() {
      const live = fromSource({ name: "test", read: () => Effect.succeed(Option.some("Warn")) });

      assert.deepStrictEqual(yield* levelsLogged(atLevelLayer(live, none)), ["Warn"]);
    }),
  );

  it.effect("logs at Info with the default port", () =>
    Effect.gen(function* info() {
      const seen = yield* levelsLogged(atLevelLayer(LiveKnobs.defaultValue(), none));

      assert.deepStrictEqual(seen, ["Info", "Warn"]);
    }),
  );

  it.effect("passes the browser's effect through unchanged", () =>
    Effect.gen(function* browser() {
      assert.deepStrictEqual(yield* levelsLogged(unleveledLayer), ["Info", "Warn"]);
    }),
  );
});
