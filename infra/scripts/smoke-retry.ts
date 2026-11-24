import { Console, Duration, Effect, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { FORWARD_PREFIXES } from "../../apps/web/src/forward-prefixes.ts";

/**
 * The total time {@link sendRetrying} keeps retrying one non-credential GET, and
 * {@link retryPlatformNotFound} one request the platform answers with its not-found page: 60
 * seconds. A route that still answers that way after it fails with the last answer. It covers a
 * stage's first deploy, where a Worker route can answer 404 for a short while after its create.
 */
export const RETRY_WINDOW = Duration.seconds(60);

/**
 * The longest single wait between retries, so the exponential delays (1s, 2s, 4s, 8s, 8s, ...) keep
 * sampling inside {@link RETRY_WINDOW}.
 */
const RETRY_DELAY_CAP = Duration.seconds(8);

export const retrySchedule = Schedule.exponential(Duration.seconds(1)).pipe(
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
export const excerpt = (text: string) => text.slice(0, EXCERPT_LENGTH);

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
