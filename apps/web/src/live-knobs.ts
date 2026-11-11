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
 * a value the schema rejects all answer the tier (b) value.
 *
 * @param binding - The `KNOBS` binding of the Worker.
 * @returns The port that provides `LiveKnobs`.
 */
export const webKnobs = (binding: KnobsBinding): LiveKnobsPort =>
  fromSource({
    name: "KNOBS",
    read: (key) =>
      Effect.tryPromise({
        catch: (cause) => new LiveSourceError({ cause, source: "KNOBS" }),
        try: () => binding.get(key, { cacheTtl: CACHE_TTL_S }),
      }).pipe(Effect.map(Option.fromNullishOr)),
  });
