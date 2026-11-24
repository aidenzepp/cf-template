import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CREDENTIAL_ROUTES } from "@workspace/contract/domain/auth-endpoints";
import { ProviderId } from "@workspace/config/auth-methods";
import { RETRY_WINDOW, excerpt, retryPlatformNotFound, retrySchedule } from "./smoke/retry.ts";

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
interface SmokeTarget {
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
