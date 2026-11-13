import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ABSENT_PROVIDER, SmokeFailed, runSmoke } from "./smoke.ts";

const PROD = "https://prod.example.workers.dev";

const PREVIEW = "https://preview.example.workers.dev";

/**
 * A fake client over a route table, recording every request path it served.
 */
const fake = (
  routes: Record<string, { status: number; body: unknown }>,
  seen: Array<string> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const path = new URL(request.url).pathname;

      const sent =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

      const key = sent.includes(ABSENT_PROVIDER) ? `${path}#absent` : path;
      seen.push(key);

      const route = routes[key] ?? { body: "unrouted", status: 500 };

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(route.body, { status: route.status })),
      );
    }),
  );

const healthy = {
  "/auth/get-session": { body: null, status: 200 },
  "/auth/ok": { body: { ok: true }, status: 200 },
  "/auth/sign-in/social": {
    body: {
      url: `https://github.com/login?redirect_uri=${encodeURIComponent(`${PROD}/auth/callback/github`)}`,
    },
    status: 200,
  },
  "/auth/sign-in/social#absent": { body: { code: "PROVIDER_NOT_FOUND" }, status: 404 },
};

const target = { origin: PREVIEW, prodOrigin: PROD, providers: ["github"] as const };

describe("smoke", () => {
  it.effect("passes when the preview signs in through prod's callback", () =>
    runSmoke(target).pipe(Effect.provide(fake(healthy))),
  );

  it.effect("fails and names the Worker when redirect_uri is the preview's own", () =>
    Effect.gen(function* wrongCallback() {
      const own = {
        ...healthy,
        "/auth/sign-in/social": {
          body: {
            url: `https://github.com/login?redirect_uri=${encodeURIComponent(`${PREVIEW}/auth/callback/github`)}`,
          },
          status: 200,
        },
      };

      const failure = yield* Effect.flip(runSmoke(target).pipe(Effect.provide(fake(own))));

      assert.instanceOf(failure, SmokeFailed);
      assert.strictEqual(failure.worker, "auth");
      assert.include(failure.message, `${PROD}/auth/callback/github`);
    }),
  );

  it.effect("fails when smoke-absent is not PROVIDER_NOT_FOUND", () =>
    Effect.gen(function* absentRegistered() {
      const bad = { ...healthy, "/auth/sign-in/social#absent": { body: {}, status: 200 } };
      const failure = yield* Effect.flip(runSmoke(target).pipe(Effect.provide(fake(bad))));

      assert.include(failure.message, "PROVIDER_NOT_FOUND");
    }),
  );

  it.effect("sends no more than four credential-route requests", () =>
    Effect.gen(function* budget() {
      const seen: Array<string> = [];
      yield* runSmoke(target).pipe(Effect.provide(fake(healthy, seen)));

      const credential = seen.filter((path) => path.startsWith("/auth/sign-in/email"));

      assert.isAtMost(credential.length, 4);
    }),
  );
});
