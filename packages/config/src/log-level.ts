import { Effect, LogLevel, References, Schema } from "effect";
import { Knob, LiveKnobs } from "./knob.ts";

/**
 * The minimum level a Worker logs at, read as `LOG_LEVEL` and defaulting to `Info`.
 */
export const LogLevelKnob = Knob.make(
  "LOG_LEVEL",
  Schema.Literals(LogLevel.values).annotate({
    default: "Info",
    description: "Minimum level a Worker logs at.",
  }),
);

/**
 * Bind {@link LogLevelKnob} through the `LiveKnobs` port, once.
 *
 * The result reads the live level on each call. It needs a `ConfigProvider` that holds the Worker's
 * bindings, because the port resolves tier (b) here, and fails with `Config.ConfigError` when that
 * deploy-time value is invalid, so a Worker with a bad `LOG_LEVEL` never takes traffic.
 */
export const liveLogLevel = Effect.gen(function* bindLogLevel() {
  const knobs = yield* LiveKnobs;

  return yield* knobs.bind(LogLevelKnob);
});

/**
 * Make the function that runs a request's effect at the minimum log level `level` answers.
 *
 * The level is read once per call of the returned function, so every log of that request, including
 * the ones inside spans and forks, filters at the same level. This is Effect's own
 * `References.MinimumLogLevel`; no logger is replaced.
 *
 * @param level - Reads the live level, such as the result of {@link liveLogLevel}.
 * @returns A function that runs an effect at that level.
 */
export const atLogLevel =
  (level: Effect.Effect<LogLevel.LogLevel>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    level.pipe(
      Effect.flatMap((minimum) =>
        Effect.provideService(effect, References.MinimumLogLevel, minimum),
      ),
    );
