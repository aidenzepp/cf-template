import type { Effect } from "effect";

declare const failing: Effect.Effect<number, string>;

export const widened = failing as Effect.Effect<number, string | Error>;
