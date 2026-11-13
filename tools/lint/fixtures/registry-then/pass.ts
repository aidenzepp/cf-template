import { Effect } from "effect";

export const settled = Effect.tryPromise(() => Promise.resolve(1)).pipe(
  Effect.orElseSucceed(() => 0),
);
