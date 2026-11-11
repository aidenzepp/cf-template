import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { TestClock } from "effect/testing";
import { makeReceive } from "./latch.ts";

const POLICY = "policy-1";

const PERIOD_END = Date.UTC(2026, 11, 1) / 1000;

/**
 * A recorded write to the fake KV.
 */
interface Put {
  readonly expiration: number;
  readonly key: string;
  readonly value: string;
}

/**
 * Deliver `delivery` to a receiver over a fake KV that records its writes and fails them when
 * `fails` is set; the clock sits inside November 2026. Returns the writes and the logs.
 */
const deliver = (
  delivery: { policyId: string | undefined; ts: number },
  options: { readonly fails?: boolean; readonly policy?: string | undefined } = {},
) =>
  Effect.gen(function* delivering() {
    yield* TestClock.setTime(Date.UTC(2026, 10, 11, 12));

    const puts: Array<Put> = [];
    const logs: Array<string> = [];

    const logger = Logger.make(({ message, logLevel }) => {
      logs.push(`${logLevel}:${String(message)}`);
    });

    const receive = makeReceive({
      policy: Effect.succeed("policy" in options ? options.policy : POLICY),
      put: (key, value, settings) =>
        options.fails === true
          ? Effect.fail("kv down")
          : Effect.sync(() => {
              puts.push({ expiration: settings.expiration, key, value });
            }),
    });

    yield* receive({ alertCorrelationId: "corr-1", ...delivery }).pipe(
      Effect.provide(Logger.layer([logger])),
    );

    return { logs, puts };
  });

describe("makeReceive", () => {
  it.effect("latches the guard alert's notification until the period end", () =>
    Effect.gen(function* latched() {
      const { puts } = yield* deliver({ policyId: POLICY, ts: 1_700_000_000 });

      assert.deepStrictEqual(puts, [
        {
          expiration: PERIOD_END,
          key: "state",
          value: '{"at":1700000000,"correlationId":"corr-1","latched":true}',
        },
      ]);
    }),
  );

  it.effect("writes nothing for another policy", () =>
    Effect.gen(function* foreign() {
      const { puts } = yield* deliver({ policyId: "policy-2", ts: 1 });

      assert.deepStrictEqual(puts, []);
    }),
  );

  it.effect("writes nothing for a notification without a policy id", () =>
    Effect.gen(function* anonymous() {
      const { puts } = yield* deliver({ policyId: undefined, ts: 1 }, { policy: undefined });

      assert.deepStrictEqual(puts, []);
    }),
  );

  it.effect("logs web.guard.latch_error and does not fail when the write fails", () =>
    Effect.gen(function* failing() {
      const { logs, puts } = yield* deliver({ policyId: POLICY, ts: 1 }, { fails: true });

      assert.deepStrictEqual(puts, []);
      assert.deepStrictEqual(logs, ["Error:web.guard.latch_error"]);
    }),
  );
});
