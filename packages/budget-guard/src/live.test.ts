import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Predicate, Ref } from "effect";
import { TestClock } from "effect/testing";
import { periodEnd } from "./latch.ts";
import { makeCheck } from "./live.ts";

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
      const { responses } = yield* ask(Effect.succeed(true), ["/", "/notes"]);

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

describe("periodEnd", () => {
  it.effect("is the first second of the next UTC month", () =>
    Effect.gen(function* end() {
      yield* TestClock.setTime(Date.UTC(2026, 10, 11, 12));

      assert.strictEqual(yield* periodEnd, Date.UTC(2026, 11, 1) / 1000);
    }),
  );
});
