import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { WorkersSubdomainMissing, interimPublicOrigin } from "./auth.ts";

describe("interimPublicOrigin", () => {
  it.effect("is the workers.dev address of the web Worker on a cloud stage", () =>
    Effect.gen(function* cloud() {
      const origin = yield* interimPublicOrigin({
        stack: "stack",
        stage: "test-i08",
        subdomain: Option.some("acme"),
      });

      assert.strictEqual(origin, "https://stack-web-test-i08.acme.workers.dev");
    }),
  );

  it.effect("is the local dev server on the local kind", () =>
    Effect.gen(function* local() {
      const origin = yield* interimPublicOrigin({
        stack: "stack",
        stage: "dev",
        subdomain: Option.none(),
      });

      assert.strictEqual(origin, "http://localhost:3000");
    }),
  );

  it.effect("fails on a cloud stage without a subdomain", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(
        interimPublicOrigin({ stack: "stack", stage: "prod", subdomain: Option.none() }),
      );

      assert.instanceOf(error, WorkersSubdomainMissing);
    }),
  );
});
