import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkerBindings } from "@workspace/config/web-guard";
import type { KvReader } from "@workspace/config/web-guard";
import { refusal } from "./guard.ts";
import { WebRequestLayers } from "./request-layers.ts";

/**
 * A Worker env whose `GUARD_KV` answers every read with `value`, or an env with no binding at all.
 */
const envWith = (value: string | null | undefined) =>
  Layer.succeed(WorkerBindings, {
    kv: (name) =>
      new Map<string, KvReader>(
        value === undefined ? [] : [["GUARD_KV", { get: () => Promise.resolve(value) }]],
      ).get(name),
  });

/**
 * Ask {@link WebRequestLayers}, built over `env`, about `/` the way the server entry does: through
 * a runtime that builds the layers once.
 */
const askThrough = (env: Layer.Layer<WorkerBindings>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ManagedRuntime.make(WebRequestLayers.pipe(Layer.provide(env)))),
    (runtime) =>
      Effect.promise(() => runtime.runPromise(refusal(new Request("https://app.test/")))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );

describe("WebRequestLayers", () => {
  it.effect("attaches the budget guard: a set latch refuses with 503", () =>
    Effect.gen(function* latched() {
      const response = yield* askThrough(envWith("{}"));

      assert.strictEqual(response?.status, 503);
    }),
  );

  it.effect("serves when the latch is clear", () =>
    Effect.gen(function* clear() {
      assert.strictEqual(yield* askThrough(envWith(null)), undefined);
    }),
  );

  it.effect("serves when the guard binding is missing", () =>
    Effect.gen(function* unbound() {
      assert.strictEqual(yield* askThrough(envWith(undefined)), undefined);
    }),
  );
});
