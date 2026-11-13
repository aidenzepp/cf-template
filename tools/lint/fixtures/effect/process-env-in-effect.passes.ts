import { Effect } from "effect";

export const home = Effect.gen(function* read() {
  yield* Effect.log("reading");

  return "/home/example";
});
