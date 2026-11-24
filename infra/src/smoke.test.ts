import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  ABSENT_PROVIDER,
  PlatformNotFound,
  SmokeFailed,
  isPlatformNotFound,
  retryPlatformNotFound,
  runSmoke,
} from "./smoke.ts";

const PROD = "https://prod.example.workers.dev";

const PREVIEW = "https://preview.example.workers.dev";

/**
 * One canned answer: a JSON body, or with `html` the platform's not-found page as `text/html`.
 */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly html?: true;
}

/**
 * The start of the page the platform answers for a `workers.dev` route its edge does not know yet,
 * as probed on a fresh `test-*` stage.
 */
const PLATFORM_PAGE = "<!DOCTYPE html><title>Page not found</title>";

/**
 * The platform's not-found page as an {@link Answer}.
 */
const platform404: Answer = { body: PLATFORM_PAGE, html: true, status: 404 };

const toWeb = (answer: Answer) =>
  answer.html === true
    ? new Response(String(answer.body), {
        headers: { "content-type": "text/html; charset=UTF-8" },
        status: answer.status,
      })
    : Response.json(answer.body, { status: answer.status });

/**
 * A fake client over a route table, recording every request path it served.
 */
const fake = (
  routes: Record<string, Answer>,
  seen: Array<string> = [],
  queued: Record<string, Array<Answer>> = {},
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

      return Effect.succeed(HttpClientResponse.fromWeb(request, toWeb(route)));
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
  it.effect("retries the absent-provider sign-in on the platform's not-found page", () =>
    Effect.gen(function* platformThenAnswer() {
      const seen: Array<string> = [];
      const queued = { "/auth/sign-in/social#absent": [platform404] };

      const fiber = yield* Effect.forkChild(
        runSmoke(target).pipe(Effect.provide(fake(healthy, seen, queued))),
      );

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);

      assert.strictEqual(seen.filter((path) => path === "/auth/sign-in/social#absent").length, 2);
    }),
  );

  it.effect("retries a platform not-found page that follows correct answers", () =>
    Effect.gen(function* flapping() {
      const seen: Array<string> = [];

      const queued = {
        "/auth/get-session": [platform404],
        "/auth/ok": [{ body: { ok: true }, status: 200 }],
      };

      const fiber = yield* Effect.forkChild(
        runSmoke(target).pipe(Effect.provide(fake(healthy, seen, queued))),
      );

      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);

      assert.strictEqual(seen.filter((path) => path === "/auth/get-session").length, 2);
    }),
  );

  it.effect("fails with the page's body when the platform's not-found page persists", () =>
    Effect.gen(function* neverSettles() {
      const bad = { ...healthy, "/auth/sign-in/social#absent": platform404 };

      const fiber = yield* Effect.forkChild(
        Effect.flip(runSmoke(target).pipe(Effect.provide(fake(bad)))),
      );

      yield* TestClock.adjust("2 minutes");

      const failure = yield* Fiber.join(fiber);

      assert.instanceOf(failure, SmokeFailed);
      assert.include(failure.message, "Page not found");
    }),
  );

  it.effect(
    "quotes the body when the absent provider answers an application 404 without the code",
    () =>
      Effect.gen(function* applicationNotFound() {
        const seen: Array<string> = [];

        const bad = {
          ...healthy,
          "/auth/sign-in/social#absent": { body: { message: "elsewhere" }, status: 404 },
        };

        const failure = yield* Effect.flip(runSmoke(target).pipe(Effect.provide(fake(bad, seen))));

        assert.include(failure.message, "elsewhere");
        assert.strictEqual(seen.filter((path) => path === "/auth/sign-in/social#absent").length, 1);
      }),
  );
});

/**
 * A response to `GET <path>` on the preview carrying one canned answer.
 */
const response = (path: string, answer: Answer) =>
  HttpClientResponse.fromWeb(HttpClientRequest.get(`${PREVIEW}${path}`), toWeb(answer));

describe("isPlatformNotFound", () => {
  it("is the HTML 404 on a path web forwards to api or auth", () => {
    assert.isTrue(
      isPlatformNotFound("/auth/sign-up/email", response("/auth/sign-up/email", platform404)),
    );
    assert.isTrue(isPlatformNotFound("/api/CreateNote", response("/api/CreateNote", platform404)));
  });

  it("is not an application 404, web's own page or a success", () => {
    const provider = { body: { code: "PROVIDER_NOT_FOUND" }, status: 404 };

    assert.isFalse(
      isPlatformNotFound("/auth/sign-in/social", response("/auth/sign-in/social", provider)),
    );
    assert.isFalse(isPlatformNotFound("/nowhere", response("/nowhere", platform404)));
    assert.isFalse(
      isPlatformNotFound("/auth/ok", response("/auth/ok", { ...platform404, status: 200 })),
    );
  });
});

describe("retryPlatformNotFound", () => {
  it.effect("sends a credential request again after the platform's not-found page", () =>
    Effect.gen(function* signUpRetried() {
      const seen: Array<string> = [];
      const queued = { "/auth/sign-up/email": [platform404] };
      const routes = { "/auth/sign-up/email": { body: { user: { id: "u-1" } }, status: 200 } };

      const fiber = yield* Effect.forkChild(
        Effect.gen(function* signUp() {
          const client = retryPlatformNotFound(yield* HttpClient.HttpClient);

          return yield* client.execute(HttpClientRequest.post(`${PREVIEW}/auth/sign-up/email`));
        }).pipe(Effect.provide(fake(routes, seen, queued))),
      );

      yield* TestClock.adjust("1 second");

      const answer = yield* Fiber.join(fiber);

      assert.strictEqual(answer.status, 200);
      assert.strictEqual(seen.length, 2);
    }),
  );

  it.effect(
    "returns an application 404 at once and fails with PlatformNotFound only for the page",
    () =>
      Effect.gen(function* notRetried() {
        const seen: Array<string> = [];
        const routes = { "/api/Note/n-1": { body: { _tag: "NotFound" }, status: 404 } };

        const answer = yield* Effect.gen(function* read() {
          const client = retryPlatformNotFound(yield* HttpClient.HttpClient);

          return yield* client.execute(HttpClientRequest.get(`${PREVIEW}/api/Note/n-1`));
        }).pipe(Effect.provide(fake(routes, seen)));

        assert.strictEqual(answer.status, 404);
        assert.strictEqual(seen.length, 1);

        const fiber = yield* Effect.forkChild(
          Effect.flip(
            Effect.gen(function* page() {
              const client = retryPlatformNotFound(yield* HttpClient.HttpClient);

              return yield* client.execute(HttpClientRequest.get(`${PREVIEW}/api/Note/n-1`));
            }).pipe(Effect.provide(fake({ "/api/Note/n-1": platform404 }))),
          ),
        );

        yield* TestClock.adjust("2 minutes");

        const failure = yield* Fiber.join(fiber);

        assert.instanceOf(failure, PlatformNotFound);
        assert.include(failure.message, "Page not found");
      }),
  );
});
