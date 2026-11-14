import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Duration, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CREDENTIAL_ROUTES } from "../../packages/contract/src/domain/auth-endpoints.ts";
import { ProviderId } from "../../packages/config/src/auth-methods.ts";

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
 * Send one request to the `auth` Worker through the credential budget and return its status and
 * decoded JSON body.
 */
const send = Effect.fn("smoke.send")(function* send(
  budget: { used: number },
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
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

  return { body, status: response.status };
});

/**
 * The total time {@link sendRetrying} keeps retrying one non-credential GET: 60 seconds. A route
 * that still answers 404 or 5xx after it fails the smoke with the last status. It covers a stage's
 * first deploy, where a Worker route can answer 404 for a short while after its create.
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
          message: `GET ${path} answered ${response.status}, expected a non-404, non-5xx answer within ${Duration.format(RETRY_WINDOW)}.`,
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
 * Check a deployed stage over HTTP: `/auth/ok` answers 200, `/auth/get-session` answers 200 `null`,
 * each listed provider's sign-in returns `prod`'s callback as `redirect_uri` (the OAuth proxy), and
 * the absent provider answers 404 `PROVIDER_NOT_FOUND`. Requests to `credential` routes stay within
 * {@link CREDENTIAL_REQUEST_LIMIT}.
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

  const ok = yield* sendRetrying(budget, HttpClientRequest.get(at("/auth/ok")));
  yield* expect(ok.status === 200, `GET /auth/ok answered ${ok.status}, expected 200.`);

  const session = yield* sendRetrying(budget, HttpClientRequest.get(at("/auth/get-session")));
  yield* expect(
    session.status === 200 && session.body === null,
    `GET /auth/get-session answered ${session.status}, expected 200 null.`,
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
      `Sign-in for ${provider} used redirect_uri ${String(actual)}, expected ${expected}.`,
    );
  }

  const absent = yield* signIn(ABSENT_PROVIDER);
  yield* expect(
    absent.status === 404 &&
      Schema.is(Schema.Struct({ code: Schema.Literal("PROVIDER_NOT_FOUND") }))(absent.body),
    `Sign-in for ${ABSENT_PROVIDER} answered ${absent.status}, expected 404 PROVIDER_NOT_FOUND.`,
  );
});

/**
 * Smoke the stage `SMOKE_ORIGIN` points at, with `PROD_ORIGIN` as the expected callback host and
 * `SMOKE_PROVIDERS` as a JSON array of provider ids (empty when unset). Exits non-zero on the
 * first failure.
 *
 * Usage: `SMOKE_ORIGIN=... PROD_ORIGIN=... bun infra/scripts/smoke.ts`.
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
