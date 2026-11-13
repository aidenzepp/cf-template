import type { Effect } from "effect";

declare const failing: Effect.Effect<number, string>;

export const narrowed = failing as Effect.Effect<number, never>;
