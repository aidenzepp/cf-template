import { Context, Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import type { RawDatabase } from "../src/database.ts";
import fixture from "./fixture.sql?raw";

/**
 * The local D1 binding the db tests run against.
 */
export class LocalD1 extends Context.Service<LocalD1, RawDatabase>()("@workspace/db/LocalD1") {
  /**
   * Starts a Miniflare D1 with the fixture applied and disposes it when the layer's scope closes.
   */
  static readonly layer = Layer.effect(
    LocalD1,
    Effect.gen(function* startLocalD1() {
      const miniflare = yield* Effect.acquireRelease(
        Effect.sync(() => new Miniflare({ d1Databases: ["DB"], modules: true, script: "" })),
        (instance) => Effect.promise(() => instance.dispose()),
      );

      const binding = yield* Effect.promise(() => miniflare.getD1Database("DB"));

      yield* Effect.promise(() => binding.exec(fixture.trim()));

      return binding;
    }),
  );
}
