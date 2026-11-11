import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RequestGuard } from "@workspace/config/web-guard";
import { refusal } from "./guard.ts";

describe("refusal", () => {
  it.effect("serves when no block provides a guard", () =>
    Effect.gen(function* unguarded() {
      assert.strictEqual(yield* refusal(new Request("https://app.test/")), undefined);
    }),
  );

  it.effect("returns the response the guard refuses with", () =>
    Effect.gen(function* guarded() {
      const response = yield* refusal(new Request("https://app.test/notes")).pipe(
        Effect.provide(
          Layer.succeed(RequestGuard, {
            check: (request) =>
              Effect.succeed(
                new URL(request.url).pathname === "/notes"
                  ? new Response(null, { status: 503 })
                  : undefined,
              ),
          }),
        ),
      );

      assert.strictEqual(response?.status, 503);
    }),
  );
});
