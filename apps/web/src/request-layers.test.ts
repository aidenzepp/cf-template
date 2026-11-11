import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkerBindings } from "@workspace/config/web-guard";
import type { KvReader } from "@workspace/config/web-guard";
import { refusal } from "./guard.ts";
import { WebRequestLayers } from "./request-layers.ts";

/**
 * A Worker env with no binding at all.
 */
const EMPTY_ENV = Layer.succeed(WorkerBindings, {
  kv: (name) => new Map<string, KvReader>().get(name),
});

/**
 * Ask `layers`, built over {@link EMPTY_ENV}, about `/` the way the server entry does: through a
 * runtime that builds the layers once.
 */
const askThrough = <E>(layers: Layer.Layer<never, E, WorkerBindings>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ManagedRuntime.make(layers.pipe(Layer.provide(EMPTY_ENV)))),
    (runtime) =>
      Effect.promise(() => runtime.runPromise(refusal(new Request("https://app.test/")))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );

describe("WebRequestLayers", () => {
  it.effect("serves with the budget-guard entry present and its binding missing", () =>
    Effect.gen(function* bound() {
      assert.strictEqual(yield* askThrough(WebRequestLayers), undefined);
    }),
  );

  it.effect("serves with every entry pulled out, leaving only the core empty layer", () =>
    Effect.gen(function* pulledOut() {
      assert.strictEqual(yield* askThrough(Layer.mergeAll(Layer.empty)), undefined);
    }),
  );
});
