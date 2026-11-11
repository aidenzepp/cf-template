import { ConfigProvider, Context, Effect, Layer } from "effect";
import { LiveKnobs } from "@workspace/config/knob";
import type { LiveKnobsPort } from "@workspace/config/knob";
import { atLogLevel, liveLogLevel } from "@workspace/config/log-level";

/**
 * The function that runs an effect at the live `LOG_LEVEL`, bound once when the runtime of `web`
 * is built.
 */
export class AtLevel extends Context.Service<AtLevel, ReturnType<typeof atLogLevel>>()(
  "@workspace/web/AtLevel",
) {}

/**
 * The layer of the browser, which has no knobs namespace and logs at the level it was built with.
 */
export const unleveledLayer = Layer.succeed(AtLevel)(
  <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
);

/**
 * Build the layer that provides {@link AtLevel} over a live source.
 *
 * `LOG_LEVEL` is resolved here, through the `LiveKnobs` port, against the Worker's bindings. An
 * invalid deploy-time value fails the layer, so no request is served on a guess.
 *
 * @param port - The `LiveKnobs` port over the Worker's knobs namespace.
 * @param source - The Worker's bindings as a config provider, the source of the deploy-time value.
 * @returns The layer that provides {@link AtLevel}.
 */
export const atLevelLayer = (port: LiveKnobsPort, source: ConfigProvider.ConfigProvider) =>
  Layer.effect(AtLevel)(
    liveLogLevel.pipe(
      Effect.map(atLogLevel),
      Effect.provideService(LiveKnobs, port),
      Effect.provide(ConfigProvider.layer(source)),
    ),
  );

/**
 * Run an effect on the runtime of `web` at the live `LOG_LEVEL`, read once per call.
 *
 * @param effect - The effect to run.
 * @returns The effect, filtered at the live level.
 */
export const atLiveLevel = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | AtLevel> =>
  Effect.gen(function* withLevel() {
    const at = yield* AtLevel;

    return yield* at(effect);
  });
