import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AuthMethods, makeWebLayer } from "./web-layer.ts";

describe("makeWebLayer", () => {
  it.effect("decodes AUTH_METHODS once into the AuthMethods service", () =>
    Effect.gen(function* decodes() {
      const methods = yield* AuthMethods.pipe(
        Effect.provide(makeWebLayer({ AUTH_METHODS: '{"email":true,"providers":["github"]}' })),
      );

      expect(methods).toStrictEqual({ email: true, providers: ["github"] });
    }),
  );

  it.effect("fails construction on a value that is not JSON, with no fallback", () =>
    Effect.gen(function* notJson() {
      const error = yield* Effect.flip(Layer.build(makeWebLayer({ AUTH_METHODS: "{nope" })));

      expect(error._tag).toBe("SchemaError");
    }).pipe(Effect.scoped),
  );

  it.effect("fails construction on JSON of the wrong shape", () =>
    Effect.gen(function* wrongType() {
      const error = yield* Effect.flip(
        Layer.build(makeWebLayer({ AUTH_METHODS: '{"email":"yes"}' })),
      );

      expect(error._tag).toBe("SchemaError");
    }).pipe(Effect.scoped),
  );
});
