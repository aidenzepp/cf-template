import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";
import { githubToken } from "./run-credentials.ts";

/**
 * A JSON request body.
 */
type RequestBody = Schema.JsonObject;

/**
 * A GitHub REST sender: bearer-authenticated with `GITHUB_TOKEN`, rooted at `api.github.com`.
 */
export const restClient = Effect.gen(function* restClient() {
  const token = yield* githubToken;

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
      ),
    ),
  );

  return (method: HttpMethod, path: string, body?: RequestBody) =>
    client.execute(
      body === undefined
        ? HttpClientRequest.make(method)(path)
        : HttpClientRequest.make(method)(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    );
});

/**
 * The GitHub REST sender {@link restClient} builds.
 */
export type Send = Effect.Success<typeof restClient>;

/**
 * The guards {@link holds} branches on: a JSON array, and a JSON object.
 */
const isList = Schema.is(Schema.Array(Schema.Json));

const isMap = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Whether a live JSON value holds everything a declaration names. An object holds when each key of
 * the declaration holds in it (keys the declaration does not name are ignored), an array holds when
 * it has the same length and each item holds, and anything else holds when strictly equal.
 *
 * @param live - The JSON GitHub answered.
 * @param declared - The declared value, or the part of it that must hold.
 * @returns Whether `live` holds `declared`.
 */
const holds: (live: Schema.Json | undefined, declared: Schema.Json) => boolean = (
  live,
  declared,
) => {
  if (isList(declared)) {
    return (
      isList(live) &&
      live.length === declared.length &&
      declared.every((item, index) => holds(live[index], item))
    );
  }

  return isMap(declared)
    ? isMap(live) && Object.entries(declared).every(([key, value]) => holds(live[key], value))
    : live === declared;
};

/**
 * Read a setting and say whether it already holds the declared value, so the write can be skipped.
 * The read must answer 2xx. With `declared` its JSON must also hold it ({@link holds}); without it,
 * the 2xx alone is the answer (`GET .../vulnerability-alerts` answers 204 when on, 404 when off).
 * A read that fails for any reason, such as a transport error, a 403, an empty or undecodable body,
 * answers no: the write then runs as it would without the read.
 *
 * @param send - The REST sender.
 * @param path - The path the setting is read from with `GET`.
 * @param declared - The part of the response that must hold, if the status alone does not say.
 * @returns Whether the setting already holds the declared value.
 */
export const alreadyHolds = (send: Send, path: string, declared?: RequestBody) =>
  send("GET", path).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) =>
      declared === undefined
        ? Effect.succeed(true)
        : HttpClientResponse.schemaBodyJson(Schema.Json)(response).pipe(
            Effect.map((live) => holds(live, declared)),
          ),
    ),
    Effect.orElseSucceed(() => false),
  );
