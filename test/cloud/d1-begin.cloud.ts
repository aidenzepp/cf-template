import { BunHttpClient } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * The slice of a D1 REST response these tests read.
 */
const Reply = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  result: Schema.optional(Schema.Unknown),
  success: Schema.Boolean,
});

/**
 * The failure of a D1 REST call, carrying the status and the D1 error text only.
 */
class D1RequestFailed extends Schema.TaggedError<
  D1RequestFailed,
  { readonly brand: unique symbol }
>()("D1RequestFailed", {
  message: Schema.String,
}) {}

/**
 * Send a request to the D1 REST API of the account and decode the reply.
 *
 * @param request - The request with its path after `/accounts/<id>/d1/database` as its URL: `""` for
 *   the database list, `/<uuid>/query` for a query. The base is joined by concatenation, not
 *   `prependUrl`, which adds a slash between empty segments and so asks for `.../database/`, a
 *   path the first CI run (43547380980) got a 404 with a non-JSON body for.
 * @returns The HTTP status and the decoded reply.
 */
const d1 = Effect.fn("d1")(function* d1(request: HttpClientRequest.HttpClientRequest) {
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const client = yield* HttpClient.HttpClient;

  const response = yield* client.execute(
    request.pipe(
      HttpClientRequest.updateUrl(
        (path) => `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database${path}`,
      ),
      HttpClientRequest.bearerToken(Redacted.value(token)),
    ),
  );

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

  const reply = yield* Schema.decodeEffect(Schema.fromJsonString(Reply))(body).pipe(
    Effect.mapError(
      () =>
        new D1RequestFailed({
          message: `D1 replied ${response.status} with an unreadable body: ${body.slice(0, 200)}`,
        }),
    ),
  );

  return { reply, status: response.status };
});

// Runs only under `test:cloud`, with the scoped token of I-42.
describe("the deployed test-ci D1", () => {
  it.effect("rejects a BEGIN statement", () =>
    Effect.gen(function* rejectsBegin() {
      const list = yield* d1(HttpClientRequest.get("", { urlParams: { name: "test-ci" } }));

      const databases = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ uuid: Schema.String })),
      )(list.reply.result);

      const uuid = databases[0]?.uuid;

      assert.isDefined(uuid, `no D1 database named for test-ci was found (status ${list.status})`);

      const query = yield* d1(
        HttpClientRequest.post(`/${uuid}/query`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ sql: "BEGIN" }),
        ),
      );

      const text = (query.reply.errors ?? []).map((error) => error.message).join("; ");

      assert.isFalse(query.reply.success, `D1 accepted BEGIN (status ${query.status})`);
      assert.isAbove(
        text.length,
        0,
        `D1 rejected BEGIN without error text (status ${query.status})`,
      );
    }).pipe(Effect.provide(BunHttpClient.layer)),
  );
});
