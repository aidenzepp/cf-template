import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { FRESH_SESSION_CODE, betterAuthCall } from "./better-auth-call.ts";

describe("betterAuthCall", () => {
  it.effect("succeeds with the data of a response without an error", () =>
    Effect.gen(function* succeeds() {
      const data = yield* betterAuthCall(() =>
        Promise.resolve({ data: { ok: true }, error: null }),
      );

      expect(data).toStrictEqual({ ok: true });
    }),
  );

  it.effect("fails with SessionNotFresh on the fresh-session code", () =>
    Effect.gen(function* stale() {
      const failure = yield* Effect.flip(
        betterAuthCall(() => Promise.resolve({ error: { code: FRESH_SESSION_CODE, status: 403 } })),
      );

      expect(failure).toMatchObject({
        _tag: "SessionNotFresh",
        error: { code: FRESH_SESSION_CODE, status: 403 },
      });
    }),
  );

  it.effect("fails with AuthCallFailed on any other refusal", () =>
    Effect.gen(function* refused() {
      const failure = yield* Effect.flip(
        betterAuthCall(() => Promise.resolve({ error: { code: "INVALID_PASSWORD", status: 400 } })),
      );

      expect(failure).toMatchObject({
        _tag: "AuthCallFailed",
        error: { code: "INVALID_PASSWORD", status: 400 },
      });
    }),
  );

  it.effect("fails with AuthCallFailed at status 0 when the call rejects", () =>
    Effect.gen(function* rejects() {
      const failure = yield* Effect.flip(
        betterAuthCall(() => Promise.reject(new Error("offline"))),
      );

      expect(failure).toMatchObject({ _tag: "AuthCallFailed", error: { status: 0 } });
    }),
  );

  it.effect("aborts the call's signal when the effect is interrupted", () =>
    Effect.gen(function* interrupted() {
      const signals: Array<AbortSignal> = [];

      const gate = yield* Deferred.make<true>();

      const fiber = yield* Effect.forkChild(
        betterAuthCall(async (signal) => {
          signals.push(signal);
          await Effect.runPromise(Deferred.await(gate));

          return { error: null };
        }),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* Deferred.succeed(gate, true);

      expect(signals[0]?.aborted).toBeTruthy();
    }),
  );
});
