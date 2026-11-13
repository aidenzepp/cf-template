import { BunHttpClient } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { Digest } from "effect/crypto";
import { publicOrigin } from "../../infra/src/origin.ts";
import { resolveStackName } from "../../infra/src/stack-name.ts";
import { Stage } from "../../infra/stages.ts";

/**
 * The only stage the cloud suite deploys.
 */
const CLOUD_STAGE = "test-ci";

/**
 * The password of the throwaway user, long enough for Better Auth's minimum.
 */
const PASSWORD = "correct horse battery";

/**
 * The slice of a Better Auth sign-up reply this flow reads: the new user's id.
 */
const SignUpReply = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

/**
 * The receipt of a Domain command over HTTP: the stream and version the write landed at.
 */
const Receipt = Schema.Struct({
  reply: Schema.Unknown,
  stream: Schema.String,
  version: Schema.Finite,
});

describe("the deployed notes flow", () => {
  it.effect("signs a fresh user in and creates a note in the user's own notebook", () =>
    Effect.gen(function* createsNote() {
      const stage = yield* Schema.decodeEffect(Stage)(CLOUD_STAGE);
      const origin = yield* publicOrigin({ stack: yield* resolveStackName(), stage });
      const client = yield* HttpClient.HttpClient;
      const email = `notes-${crypto.randomUUID()}@example.test`;

      // A same-origin request passes the Origin check, so every call names the stage's origin.
      const signUp = yield* client.execute(
        HttpClientRequest.post(`${origin}/auth/sign-up/email`).pipe(
          HttpClientRequest.setHeader("origin", origin),
          HttpClientRequest.bodyJsonUnsafe({ email, name: "Ada Lovelace", password: PASSWORD }),
        ),
      );

      assert.strictEqual(signUp.status, 200);

      const { user } = yield* signUp.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SignUpReply)),
      );

      const cookie = Cookies.toCookieHeader(signUp.cookies);

      assert.notStrictEqual(cookie, "");

      // The notebook id is the owner's user id.
      const created = yield* client.execute(
        HttpClientRequest.post(`${origin}/api/CreateNote`).pipe(
          HttpClientRequest.setHeaders({ cookie, origin }),
          HttpClientRequest.bodyJsonUnsafe({
            commandId: crypto.randomUUID(),
            input: { body: "Written by the cloud suite.", id: "n-1", title: "First note" },
            target: user.id,
          }),
        ),
      );

      assert.strictEqual(created.status, 200);

      const receipt = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)));

      // The first event of a fresh notebook is version 1; no read operation is served yet, so the
      // read-back waits for a read contract.
      assert.strictEqual(receipt.version, 1);
      assert.isTrue(receipt.stream.length > 0);
    }).pipe(Effect.provide(BunHttpClient.layer.pipe(Layer.provideMerge(Digest.layerWebCrypto)))),
  );
});
