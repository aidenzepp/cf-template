import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, Predicate, Ref } from "effect";
import { TestClock } from "effect/testing";
import { RequestGuard, WorkerBindings, isKvReader } from "@workspace/config/web-guard";
import { BudgetGuardLive, makeCheck } from "./live.ts";
import { periodEnd } from "./latch.ts";

const BODY =
  '{"type":"/problems/budget-latched","title":"Service paused","status":503,"detail":"Request volume crossed the project\'s budget line; serving resumes when the latch clears."}';

/**
 * Build the guard over a store that answers `outcome` and counts its reads, then ask it about
 * each path of `paths` in turn, advancing `seconds` between asks.
 */
const ask = (outcome: Effect.Effect<boolean, string>, paths: ReadonlyArray<string>, seconds = 0) =>
  Effect.gen(function* asking() {
    const reads = yield* Ref.make(0);
    const logs: Array<string> = [];

    const logger = Logger.make(({ message, logLevel }) => {
      logs.push(`${logLevel}:${String(message)}`);
    });

    const responses: Array<Response | undefined> = [];

    yield* Effect.gen(function* running() {
      const check = yield* makeCheck({
        isLatched: Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(outcome)),
      });

      for (const path of paths) {
        responses.push(yield* check(new Request(`https://app.test${path}`)));
        yield* TestClock.adjust(`${seconds} seconds`);
      }
    }).pipe(Effect.provide(Logger.layer([logger])));

    return { logs, reads: yield* Ref.get(reads), responses };
  });

describe("makeCheck", () => {
  it.effect("answers 503 problem+json with Retry-After 300 while the latch is set", () =>
    Effect.gen(function* latched() {
      const { responses } = yield* ask(Effect.succeed(true), ["/", "/other"]);

      const refused = responses.filter(Predicate.isNotUndefined);

      assert.strictEqual(refused.length, 2);

      for (const response of refused) {
        assert.strictEqual(response.status, 503);
        assert.strictEqual(response.headers.get("content-type"), "application/problem+json");
        assert.strictEqual(response.headers.get("retry-after"), "300");
        assert.strictEqual(yield* Effect.promise(() => response.text()), BODY);
      }
    }),
  );

  it.effect("serves a static asset while the latch is set", () =>
    Effect.gen(function* asset() {
      const { responses } = yield* ask(Effect.succeed(true), ["/assets/app.js"]);

      assert.deepStrictEqual(responses, [undefined]);
    }),
  );

  it.effect("passes through while the latch is clear", () =>
    Effect.gen(function* clear() {
      const { responses } = yield* ask(Effect.succeed(false), ["/"]);

      assert.deepStrictEqual(responses, [undefined]);
    }),
  );

  it.effect("reads the store once inside 30 s and again after it", () =>
    Effect.gen(function* memo() {
      const first = yield* ask(Effect.succeed(false), ["/", "/", "/"], 10);
      const second = yield* ask(Effect.succeed(false), ["/", "/"], 31);

      assert.strictEqual(first.reads, 1);
      assert.strictEqual(second.reads, 2);
    }),
  );

  it.effect("passes through a failed read and logs web.guard.read_error once", () =>
    Effect.gen(function* failing() {
      const { logs, responses } = yield* ask(Effect.fail("kv down"), ["/", "/", "/"], 31);

      assert.deepStrictEqual(responses, [undefined, undefined, undefined]);
      assert.deepStrictEqual(logs, ["Error:web.guard.read_error"]);
    }),
  );
});

/**
 * Ask `BudgetGuardLive` about `/` with `bindings` as the env of the Worker, collecting its logs.
 */
const askWithBindings = (bindings: { readonly GUARD_KV?: unknown }) =>
  Effect.gen(function* asking() {
    const logs: Array<string> = [];

    const logger = Logger.make(({ message, logLevel }) => {
      logs.push(`${logLevel}:${String(message)}`);
    });

    const response = yield* Effect.gen(function* running() {
      const guard = yield* RequestGuard;

      return yield* guard.check(new Request("https://app.test/"));
    }).pipe(
      Effect.provide(
        BudgetGuardLive.pipe(
          Layer.provide(
            Layer.succeed(WorkerBindings, {
              kv: (name) =>
                name === "GUARD_KV" && isKvReader(bindings.GUARD_KV)
                  ? bindings.GUARD_KV
                  : undefined,
            }),
          ),
          Layer.provideMerge(Logger.layer([logger])),
        ),
      ),
    );

    return { logs, response };
  });

describe("BudgetGuardLive", () => {
  it.effect("refuses when the GUARD_KV binding holds the latch", () =>
    Effect.gen(function* latched() {
      const keys: Array<string> = [];

      const { response } = yield* askWithBindings({
        GUARD_KV: {
          get: (key: string) => {
            keys.push(key);

            return Promise.resolve('{"latched":true}');
          },
        },
      });

      assert.strictEqual(response?.status, 503);
      assert.deepStrictEqual(keys, ["state"]);
    }),
  );

  it.effect("serves when the GUARD_KV binding holds no latch", () =>
    Effect.gen(function* clear() {
      const { response } = yield* askWithBindings({
        GUARD_KV: { get: () => Promise.resolve(null) },
      });

      assert.strictEqual(response, undefined);
    }),
  );

  it.effect("serves and logs web.guard.read_error when the binding is missing", () =>
    Effect.gen(function* missing() {
      const { logs, response } = yield* askWithBindings({});

      assert.strictEqual(response, undefined);
      assert.deepStrictEqual(logs, ["Error:web.guard.read_error"]);
    }),
  );

  it.effect("serves and logs web.guard.read_error when the read rejects", () =>
    Effect.gen(function* rejected() {
      const { logs, response } = yield* askWithBindings({
        GUARD_KV: { get: () => Promise.reject(new Error("kv down")) },
      });

      assert.strictEqual(response, undefined);
      assert.deepStrictEqual(logs, ["Error:web.guard.read_error"]);
    }),
  );
});

describe("periodEnd", () => {
  it.effect("is the first second of the next UTC month", () =>
    Effect.gen(function* end() {
      yield* TestClock.setTime(Date.UTC(2026, 10, 11, 12));

      assert.strictEqual(yield* periodEnd, Date.UTC(2026, 11, 1) / 1000);
    }),
  );
});
