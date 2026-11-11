import { runPromise, void as nothing } from "effect/Effect";

export const started = runPromise(nothing);
