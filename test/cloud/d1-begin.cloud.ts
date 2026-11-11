import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, Schema } from "effect";

/**
 * The slice of a D1 REST response these tests read.
 */
const Reply = Schema.Struct({
  result: Schema.Array(Schema.Struct({ uuid: Schema.optional(Schema.String) })),
  success: Schema.Boolean,
});

/**
 * Call the D1 REST API of the account and decode the reply.
 *
 * @param path - The path after `/accounts/<id>/d1/database`.
 * @param init - The request options.
 * @returns The decoded reply and the HTTP status.
 */
const d1 = Effect.fn("d1")(function* d1(path: string, init?: RequestInit) {
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.String("CLOUDFLARE_API_TOKEN");

  const response = yield* Effect.tryPromise(() =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
  );

  const reply = yield* Schema.decodeUnknownEffect(Reply)(
    yield* Effect.tryPromise(() => response.json()),
  );

  return { reply, status: response.status };
});

describe("the deployed test-ci D1", () => {
  it.effect("rejects a BEGIN statement", () =>
    Effect.gen(function* rejectsBegin() {
      const list = yield* d1("?name=test-ci");
      const uuid = list.reply.result.find((database) => database.uuid !== undefined)?.uuid;

      assert.isDefined(uuid, "no D1 database named for test-ci was found");

      const query = yield* d1(`/${uuid}/query`, {
        body: JSON.stringify({ sql: "BEGIN" }),
        method: "POST",
      });

      assert.isFalse(query.reply.success);
    }),
  );
});
