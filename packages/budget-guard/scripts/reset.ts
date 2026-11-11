import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Stdio } from "effect";
import { GuardKvLive } from "../src/reset-live.ts";
import { parseStage, resetGuard } from "../src/reset.ts";

BunRuntime.runMain(
  Effect.gen(function* main() {
    yield* resetGuard(yield* parseStage(yield* (yield* Stdio.Stdio).args));
  }).pipe(Effect.provide(GuardKvLive), Effect.provide(BunServices.layer)),
);
