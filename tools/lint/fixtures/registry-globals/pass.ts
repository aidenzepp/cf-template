import { Effect, KeyValueStore } from "effect";

export const interrupted = [Effect.interrupt, KeyValueStore.layerStorage];
