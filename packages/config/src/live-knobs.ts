import { Clock, Context, Effect, Option, Schema } from "effect";
import type { Config } from "effect";
import type { Knob } from "./knob.ts";

/**
 * The failure of a live source read, such as an unreachable store.
 */
export class LiveSourceError extends Schema.TaggedError<
  LiveSourceError,
  { readonly brand: unique symbol }
>()("LiveSourceError", {
  cause: Schema.Unknown,
  source: Schema.String,
}) {
  override get message() {
    return `Live source ${this.source} could not be read.`;
  }
}

/**
 * A tier (c) value store that holds the string form of knobs by key.
 */
export interface LiveSource {
  /**
   * The store's name, used in log messages.
   */
  readonly name: string;
  /**
   * Read the string form of the value stored under `key`; `Option.none()` when it holds none.
   */
  readonly read: (key: string) => Effect.Effect<Option.Option<string>, LiveSourceError>;
}

/**
 * The shape of the {@link LiveKnobs} port.
 */
export interface LiveKnobsPort {
  /**
   * Resolve the tier (b) value of `knob` at construction and return the per-request reader.
   *
   * Construction fails with `Config.ConfigError` when the supplied tier (b) value is invalid, so a
   * Worker with a bad deploy-time value never takes traffic.
   */
  readonly bind: <A>(knob: Knob<A>) => Effect.Effect<Effect.Effect<A>, Config.ConfigError>;
}

/**
 * Annotate a log effect with the reason a knob resolved the way it did.
 *
 * @param effect - The log effect to annotate.
 * @param key - The knob's key.
 * @param reason - Why the knob resolved to the value it did.
 * @returns The log effect with `knob.<key>.reason` set.
 */
const withReason = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  key: string,
  reason: "no_adapter" | "schema_rejected",
) => effect.pipe(Effect.annotateLogs(`knob.${key}.reason`, reason));

/**
 * The port through which a Worker reads a knob after construction.
 *
 * Precedence is the schema default, then tier (b), then tier (c). The default value attaches no
 * live source: it binds tier (b) at construction, logs `knob.<KEY>.reason` as `no_adapter`, and
 * returns a reader that yields that value on every request.
 */
export const LiveKnobs = Context.Reference<LiveKnobsPort>("@workspace/config/LiveKnobs", {
  defaultValue: () => ({
    bind: <A>(knob: Knob<A>) =>
      knob.config.pipe(
        Effect.tap(() =>
          withReason(
            Effect.logInfo(`Knob ${knob.key} has no live adapter.`),
            knob.key,
            "no_adapter",
          ),
        ),
        Effect.map((value) => Effect.succeed(value)),
      ),
  }),
});

/**
 * The options of {@link fromSource}.
 */
interface FromSourceOptions {
  /**
   * Reuse each key's read result, success or failure, for this many milliseconds before the next
   * request reads the key again. Absent, every request reads the source.
   */
  readonly refreshMs?: number;
}

/**
 * One cached read of a key: when it ran and what it yielded, a failed read being `Option.none()`.
 */
interface CachedRead {
  readonly at: number;
  readonly value: Option.Option<string>;
}

/**
 * Construct a {@link LiveKnobsPort} that reads tier (c) from `source`.
 *
 * `bind` resolves only tier (b); the source is read on demand, by the returned reader, never at
 * construction, so a source that needs a request's context can back it. An absent or empty live
 * value, a failed read, and a value the knob's schema rejects all yield the tier (b) value. A
 * failed read logs at `Warning`. A rejected value logs once at `Error`, annotated
 * `knob.<KEY>.reason` as `schema_rejected`, per distinct value.
 *
 * With `refreshMs`, each key's read result, success or failure, is reused for that long, so a
 * failing source is retried after the same interval as a healthy one. An in-flight read is never
 * shared: two requests that both miss the cache both read. The cache and the set of rejected
 * values belong to the returned value, so they last as long as the isolate that built it.
 *
 * @param source - The live store to read.
 * @param options - The optional per-isolate cache.
 * @returns The port value that provides {@link LiveKnobs}.
 */
export const fromSource = (source: LiveSource, options: FromSourceOptions = {}) => {
  const cache = new Map<string, CachedRead>();
  const rejected = new Set<string>();

  const readSource = (key: string) =>
    source
      .read(key)
      .pipe(
        Effect.catchTag("LiveSourceError", (failure) =>
          Effect.logWarning(`Live source ${source.name} failed reading ${key}.`, failure).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );

  const readLive = (key: string) => {
    const { refreshMs } = options;

    if (refreshMs === undefined) {
      return readSource(key);
    }

    return Effect.gen(function* cachedRead() {
      const now = yield* Clock.currentTimeMillis;
      const hit = cache.get(key);

      if (hit !== undefined && now - hit.at < refreshMs) {
        return hit.value;
      }

      const value = yield* readSource(key);

      cache.set(key, { at: now, value });

      return value;
    });
  };

  return {
    bind: <A>(knob: Knob<A>) =>
      knob.config.pipe(
        Effect.map((base) =>
          Effect.gen(function* read() {
            const raw = yield* readLive(knob.key);

            if (Option.isNone(raw) || raw.value === "") {
              return base;
            }

            return yield* knob.decode(raw.value).pipe(
              Effect.catch(() => {
                const seen = `${knob.key}\u0000${raw.value}`;

                if (rejected.has(seen)) {
                  return Effect.succeed(base);
                }

                rejected.add(seen);

                return withReason(
                  Effect.logError("knob.live.rejected").pipe(
                    Effect.annotateLogs({ "knob.key": knob.key, "knob.source": source.name }),
                  ),
                  knob.key,
                  "schema_rejected",
                ).pipe(Effect.as(base));
              }),
            );
          }),
        ),
      ),
  };
};
