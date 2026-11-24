import { BunHttpClient } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { Digest } from "effect/crypto";
import { retryPlatformNotFound } from "../../infra/scripts/smoke-retry.ts";
import { publicOrigin } from "../../infra/src/origin.ts";
import { resolveStackName } from "../../infra/src/stack-name.ts";
import { CLOUD_STAGE, Stage } from "../../infra/stages.ts";

/**
 * The password of the throwaway user, long enough for Better Auth's minimum.
 */
const PASSWORD = "correct horse battery";

/**
 * The slice of a Better Auth sign-up reply this flow reads: the new user's id.
 */
const SignUpReply = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

/**
 * The note the flow creates and reads back.
 */
const NOTE = { body: "Written by the cloud suite.", id: "n-1", title: "First note" };

/**
 * A note as `GET /api/Note/{key}` answers it: its title, body and timestamps.
 */
const NoteRead = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
});

/**
 * The receipt of a Domain command over HTTP: the stream and version the write landed at.
 */
const Receipt = Schema.Struct({
  reply: Schema.Unknown,
  stream: Schema.String,
  version: Schema.Finite,
});

describe("the deployed notes flow", () => {
  it.effect(
    "signs a fresh user in, creates a note in the user's own notebook and reads it back",
    () =>
      Effect.gen(function* createsAndReadsNote() {
        const stage = yield* Schema.decodeEffect(Stage)(CLOUD_STAGE);
        const origin = yield* publicOrigin({ stack: yield* resolveStackName(), stage });
        // A fresh stage's edge can still answer the platform's not-found page after earlier
        // correct answers; that page alone is retried, every application answer is asserted as is.
        const client = retryPlatformNotFound(yield* HttpClient.HttpClient);
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
              input: NOTE,
              target: user.id,
            }),
          ),
        );

        assert.strictEqual(created.status, 200);

        const receipt = yield* created.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
        );

        // The first event of a fresh notebook is version 1.
        assert.strictEqual(receipt.version, 1);
        assert.isTrue(receipt.stream.length > 0);

        // The Note view keys a note as `<notebook id>~<note id>`; `stream` and `version` make the
        // read wait until the view has applied the create.
        const read = yield* client.execute(
          HttpClientRequest.get(`${origin}/api/Note/${user.id}~${NOTE.id}`).pipe(
            HttpClientRequest.setHeaders({ cookie, origin }),
            HttpClientRequest.setUrlParams({
              stream: receipt.stream,
              version: String(receipt.version),
            }),
          ),
        );

        assert.strictEqual(read.status, 200);

        const note = yield* read.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(NoteRead)));

        assert.strictEqual(note.title, NOTE.title);
        assert.strictEqual(note.body, NOTE.body);
        assert.strictEqual(note.createdAt, note.updatedAt);
      }).pipe(Effect.provide(BunHttpClient.layer.pipe(Layer.provideMerge(Digest.layerWebCrypto)))),
  );
});
