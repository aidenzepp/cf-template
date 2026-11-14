import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
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
  queued: Record<string, Array<{ status: number; body: unknown }>> = {},
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const path = new URL(request.url).pathname;

      const sent =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

      const key = sent.includes(ABSENT_PROVIDER) ? `${path}#absent` : path;
      seen.push(key);

      const route = queued[key]?.shift() ?? routes[key] ?? { body: "unrouted", status: 500 };

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

  it.effect("retries get-session once on 404 and then passes", () =>
    Effect.gen(function* retried() {
      const seen: Array<string> = [];
      const queued = { "/auth/get-session": [{ body: "not found", status: 404 }] };

      const fiber = yield* Effect.forkChild(
        runSmoke(target).pipe(Effect.provide(fake(healthy, seen, queued))),
      );

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);

      assert.strictEqual(seen.filter((path) => path === "/auth/get-session").length, 2);
    }),
  );

  it.effect("fails at once on a status that is not 404 or 5xx", () =>
    Effect.gen(function* notRetried() {
      const seen: Array<string> = [];
      const bad = { ...healthy, "/auth/get-session": { body: null, status: 401 } };

      const failure = yield* Effect.flip(runSmoke(target).pipe(Effect.provide(fake(bad, seen))));

      assert.include(failure.message, "401");
      assert.strictEqual(seen.filter((path) => path === "/auth/get-session").length, 1);
    }),
  );

  it.effect("gives up on a persistent 404 after the window and names the status", () =>
    Effect.gen(function* exhausted() {
      const bad = { ...healthy, "/auth/get-session": { body: "nope", status: 404 } };

      const fiber = yield* Effect.forkChild(
        Effect.flip(runSmoke(target).pipe(Effect.provide(fake(bad)))),
      );

      yield* TestClock.adjust("2 minutes");

      const failure = yield* Fiber.join(fiber);

      assert.include(failure.message, "404");
    }),
  );
});
