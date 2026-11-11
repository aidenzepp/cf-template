import { Effect } from "effect";

const cache = new Map<string, number>([["a", 1]]);

export const described = Effect.all([Effect.succeed(cache.get("a")), Effect.succeed([...cache.values()])]);
