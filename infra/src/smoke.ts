import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Duration, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { CREDENTIAL_ROUTES } from "@workspace/contract/domain/auth-endpoints";
import { ProviderId } from "@workspace/config/auth-methods";
import { FORWARD_PREFIXES } from "../../apps/web/src/forward-prefixes.ts";

/**
 * The most requests one smoke run may send to routes of the `credential` rate-limit class, so the
 * smoke never trips the strict limiter on the deployment it checks.
 */
const CREDENTIAL_REQUEST_LIMIT = 4;

/**
 * The provider id no deployment registers; Better Auth must answer 404 `PROVIDER_NOT_FOUND`.
 */
export const ABSENT_PROVIDER = "smoke-absent";

/**
 * A failed smoke check. `worker` names the Worker that misbehaved, so the failure line says where
 * to look.
 */
export class SmokeFailed extends Schema.TaggedError<
  SmokeFailed,
  { readonly brand: unique symbol }
>()("SmokeFailed", {
  message: Schema.String,
  worker: Schema.String,
}) {}

/**
 * What one smoke run checks.
 */
export interface SmokeTarget {
  /**
   * The public origin of the deployment under test, without a trailing slash.
   */
  readonly origin: string;
  /**
   * The `prod` public origin, the only host registered as an OAuth callback with a provider.
   */
  readonly prodOrigin: string;
  /**
   * The providers `AUTH_METHODS` lists on this deployment.
   */
  readonly providers: ReadonlyArray<typeof ProviderId.Type>;
}

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * The total time {@link sendRetrying} keeps retrying one non-credential GET, and
 * {@link retryPlatformNotFound} one request the platform answers with its not-found page: 60
 * seconds. A route that still answers that way after it fails with the last answer. It covers a
 * stage's first deploy, where a Worker route can answer 404 for a short while after its create.
 */
const RETRY_WINDOW = Duration.seconds(60);

/**
 * The longest single wait between retries, so the exponential delays (1s, 2s, 4s, 8s, 8s, ...) keep
 * sampling inside {@link RETRY_WINDOW}.
 */
const RETRY_DELAY_CAP = Duration.seconds(8);

const retrySchedule = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, RETRY_DELAY_CAP))),
  Schedule.upTo({ duration: RETRY_WINDOW }),
);

/**
 * The most characters of a response body a failure message quotes.
 */
const EXCERPT_LENGTH = 200;

/**
 * The first {@link EXCERPT_LENGTH} characters of a response's text, so a failure line shows which
 * layer answered.
 */
const excerpt = (text: string) => text.slice(0, EXCERPT_LENGTH);

/**
 * The path prefixes `web` hands to `api` and `auth` before its own router sees them, from the
 * `FORWARD_PREFIXES` globs that end in `/*`: `/api/` and `/auth/`.
 */
const FORWARDED_PATH_PREFIXES = FORWARD_PREFIXES.filter((prefix) => prefix.endsWith("/*")).map(
  (prefix) => prefix.slice(0, -1),
);

/**
 * Whether a response is the platform's own not-found page rather than an answer of the stack: a
 * 404 with a `text/html` body on a path under `/api/` or `/auth/`. `web` forwards those paths to
 * `api` and `auth`, which answer JSON, including their own 404s (`PROVIDER_NOT_FOUND`), so an
 * HTML 404 there comes from an edge that does not route the stage's `web` Worker yet. A fresh
 * stage answers it for up to about ten seconds after `web` is created, after earlier correct
 * answers too (cloud runs 43914500046, 43951711323 and 43952738121).
 *
 * @param path - The request path.
 * @param response - The response.
 * @returns `true` for the platform's not-found page on a forwarded path.
 */
export const isPlatformNotFound = (path: string, response: HttpClientResponse.HttpClientResponse) =>
  response.status === 404 &&
  FORWARDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
  (response.headers["content-type"] ?? "").startsWith("text/html");

/**
 * A request under `/api/` or `/auth/` that the platform answered with its own not-found page,
 * raised so {@link retryPlatformNotFound} can send the request again.
 */
export class PlatformNotFound extends Schema.TaggedError<
  PlatformNotFound,
  { readonly brand: unique symbol }
>()("PlatformNotFound", {
  message: Schema.String,
}) {}

/**
 * Wrap a client so a request the platform answers with its not-found page (see
 * {@link isPlatformNotFound}) is sent again under {@link retrySchedule}, logging one line per
 * attempt, and fails with a {@link PlatformNotFound} quoting the body once the window ends. Every
 * other answer, an application 404 included, returns at once and unchanged. The page is answered
 * before `web` runs, so its rate limiter does not count a retried request.
 *
 * @param client - The client the cloud suite or the smoke sends with.
 * @returns The same client with the bounded retry in front of every response.
 */
export const retryPlatformNotFound = <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
  client.pipe(
    HttpClient.transformResponse((effect) =>
      Effect.flatMap(effect, (response) => {
        const path = new URL(response.request.url).pathname;

        return isPlatformNotFound(path, response)
          ? response.text.pipe(
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((text) => {
                const message = `${response.request.method} ${path} answered the platform's not-found page (404 text/html), not the stack: ${excerpt(text)}`;

                return Console.log(`smoke retry: ${message}`).pipe(
                  Effect.andThen(Effect.fail(new PlatformNotFound({ message }))),
                );
              }),
            )
          : Effect.succeed(response);
      }),
    ),
    HttpClient.retry({
      schedule: retrySchedule,
      while: (error) => error instanceof PlatformNotFound,
    }),
  );

/**
 * Send one request to the `auth` Worker through the credential budget and return its status and
 * decoded JSON body. The platform's not-found page is retried under {@link retryPlatformNotFound}.
 */
const send = Effect.fn("smoke.send")(function* send(
  budget: { used: number },
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = retryPlatformNotFound(yield* HttpClient.HttpClient);
  const url = new URL(request.url);

  if (CREDENTIAL_ROUTES.includes(url.pathname)) {
    budget.used += 1;

    if (budget.used > CREDENTIAL_REQUEST_LIMIT) {
      return yield* new SmokeFailed({
        message: `Smoke would send ${budget.used} requests to credential routes; the limit is ${CREDENTIAL_REQUEST_LIMIT}.`,
        worker: "auth",
      });
    }
  }

  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (cause) => new SmokeFailed({ message: `${request.url}: ${cause.message}`, worker: "auth" }),
      ),
    );

  const text = yield* response.text.pipe(
    Effect.mapError(
      (cause) => new SmokeFailed({ message: `${request.url}: ${cause.message}`, worker: "auth" }),
    ),
  );

  const body = yield* Schema.decodeEffect(JsonBody)(text).pipe(Effect.orElseSucceed(() => text));

  return { body, excerpt: excerpt(text), status: response.status };
});

/**
 * Whether a status is one a fresh deploy can answer transiently: 404 or any 5xx.
 */
const isRetryable = (status: number) => status === 404 || status >= 500;

/**
 * {@link send} for a non-credential GET: retries a 404, a 5xx or a transport error under
 * {@link retrySchedule}, logging one line per failed attempt. Any other status returns at once.
 * When the window ends, fails with a {@link SmokeFailed} naming the last status. Never use it for
 * a credential route or a sign-in POST, whose 404 is an expected answer.
 */
const sendRetrying = Effect.fn("smoke.sendRetrying")(function* sendRetrying(
  budget: { used: number },
  request: HttpClientRequest.HttpClientRequest,
) {
  const path = new URL(request.url).pathname;
  let attempt = 0;

  return yield* send(budget, request).pipe(
    Effect.filterOrFail(
      (response) => !isRetryable(response.status),
      (response) =>
        new SmokeFailed({
          message: `GET ${path} answered ${response.status}, expected a non-404, non-5xx answer within ${Duration.format(RETRY_WINDOW)}: ${response.excerpt}`,
          worker: "auth",
        }),
    ),
    Effect.tapError((failure) =>
      Effect.sync(() => {
        attempt += 1;
      }).pipe(
        Effect.andThen(
          Console.log(`smoke retry: ${path} attempt ${attempt} failed: ${failure.message}`),
        ),
      ),
    ),
    Effect.retry(retrySchedule),
  );
});

const expect = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(new SmokeFailed({ message, worker: "auth" }));

/**
 * Wait until a freshly deployed stage serves `GET /auth/ok` with 200 through its public origin,
 * retrying a 404, a 5xx or a transport error under {@link retrySchedule}. A Worker route can answer
 * 404 for a short while after its create, so anything that calls a new stage waits on this first.
 *
 * @param origin - The public origin of the stage, without a trailing slash.
 * @returns Nothing once `/auth/ok` answers 200, or a {@link SmokeFailed} naming the last status.
 */
export const awaitAuthReady = Effect.fn("smoke.awaitAuthReady")(function* awaitAuthReady(
  origin: string,
) {
  const ok = yield* sendRetrying({ used: 0 }, HttpClientRequest.get(`${origin}/auth/ok`));
  yield* expect(
    ok.status === 200,
    `GET /auth/ok answered ${ok.status}, expected 200: ${ok.excerpt}`,
  );
});

/**
 * Check a deployed stage over HTTP: `/auth/ok` answers 200, `/auth/get-session` answers 200 `null`,
 * each listed provider's sign-in returns `prod`'s callback as `redirect_uri` (the OAuth proxy), and
 * the absent provider answers 404 `PROVIDER_NOT_FOUND`. Requests to `credential` routes stay within
 * {@link CREDENTIAL_REQUEST_LIMIT}. Every request sends again on the platform's not-found page
 * ({@link retryPlatformNotFound}), and every failure quotes the start of the body it got.
 *
 * @param target - The origin under test, `prod`'s origin and the listed providers.
 * @returns Nothing on success, or the first {@link SmokeFailed}.
 */
export const runSmoke = Effect.fn("smoke.run")(function* runSmoke(target: SmokeTarget) {
  const budget = { used: 0 };
  const at = (path: string) => `${target.origin}${path}`;

  const signIn = (provider: string) =>
    send(
      budget,
      HttpClientRequest.post(at("/auth/sign-in/social")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ callbackURL: "/", disableRedirect: true, provider }),
      ),
    );

  yield* awaitAuthReady(target.origin);

  const session = yield* sendRetrying(budget, HttpClientRequest.get(at("/auth/get-session")));
  yield* expect(
    session.status === 200 && session.body === null,
    `GET /auth/get-session answered ${session.status}, expected 200 null: ${session.excerpt}`,
  );

  for (const provider of target.providers) {
    const result = yield* signIn(provider);

    const url = Schema.is(Schema.Struct({ url: Schema.String }))(result.body)
      ? result.body.url
      : "";

    const expected = `${target.prodOrigin}/auth/callback/${provider}`;
    const actual = URL.parse(url)?.searchParams.get("redirect_uri") ?? null;

    yield* expect(
      result.status === 200 && actual === expected,
      `Sign-in for ${provider} used redirect_uri ${String(actual)}, expected ${expected}: ${result.excerpt}`,
    );
  }

  const absent = yield* signIn(ABSENT_PROVIDER);
  yield* expect(
    absent.status === 404 &&
      Schema.is(Schema.Struct({ code: Schema.Literal("PROVIDER_NOT_FOUND") }))(absent.body),
    `Sign-in for ${ABSENT_PROVIDER} answered ${absent.status}, expected 404 PROVIDER_NOT_FOUND: ${absent.excerpt}`,
  );
});

/**
 * Smoke the stage `SMOKE_ORIGIN` points at, with `PROD_ORIGIN` as the expected callback host and
 * `SMOKE_PROVIDERS` as a JSON array of provider ids (empty when unset). Exits non-zero on the
 * first failure.
 *
 * Usage: `SMOKE_ORIGIN=... PROD_ORIGIN=... bun infra/src/smoke.ts`.
 */
const program = Effect.gen(function* smokeMain() {
  const origin = yield* Config.String("SMOKE_ORIGIN");
  const prodOrigin = yield* Config.String("PROD_ORIGIN");

  const providers = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(ProviderId)),
    "SMOKE_PROVIDERS",
  ).pipe(Config.withDefault([]));

  yield* runSmoke({ origin, prodOrigin, providers }).pipe(
    Effect.tapError((failure) =>
      Console.error(`smoke failed (${failure.worker}): ${failure.message}`),
    ),
  );
  yield* Console.log("smoke passed");
});

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.provide(FetchHttpClient.layer)), {
    disableErrorReporting: true,
  });
}
