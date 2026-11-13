import { Effect, Option } from "effect";
import { LiveSourceError, fromSource } from "@workspace/config/knob";
import type { LiveKnobsPort } from "@workspace/config/knob";
import type { KnobsBinding } from "./env.ts";

/**
 * The `cacheTtl` of each read of the `KNOBS` binding, in seconds. Workers KV accepts no shorter
 * time below a minute than 30, so a flip reaches `web` within that time of the write.
 */
const CACHE_TTL_S = 30;

/**
 * The `LiveKnobs` port of `web`, over its `KNOBS` binding.
 *
 * `web` has no Worker program to bind a namespace from, and the `knobs-kv` adapter binds through
 * Alchemy's Worker services, which the `web` bundle cannot import. It reads the binding `infra`
 * declares in its `env` through the core `fromSource`: an absent or empty value, a failed read and
 * a value the schema rejects all answer the tier (b) value. With no binding, because the `knobs-kv`
 * block is absent, nothing is read and every knob answers its tier (b) value.
 *
 * The repository keeps two adapters for this one port because neither can be built on the other.
 * `web` cannot import `makeKnobsPort`, as above. `makeKnobsPort` cannot be built on `fromSource`:
 * `fromSource` reads each knob once when it binds, at layer construction, while a `knobs-kv` read
 * needs a request's `RuntimeContext` and keeps a per-isolate cache, refreshed every
 * `KNOB_REFRESH_MS`, that `fromSource` has no place for.
 *
 * @param binding - The `KNOBS` binding of the Worker, absent when the block is.
 * @returns The port that provides `LiveKnobs`.
 */
export const webKnobs = (binding: KnobsBinding | undefined): LiveKnobsPort =>
  fromSource({
    name: "KNOBS",
    read: (key) =>
      binding === undefined
        ? Effect.succeed(Option.none())
        : Effect.tryPromise({
            catch: (cause) => new LiveSourceError({ cause, source: "KNOBS" }),
            try: () => binding.get(key, { cacheTtl: CACHE_TTL_S }),
          }).pipe(Effect.map(Option.fromNullishOr)),
  });
