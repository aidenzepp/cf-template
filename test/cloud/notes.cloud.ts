import { BunHttpClient } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { Digest } from "effect/crypto";
import { retryPlatformNotFound } from "../../infra/src/smoke/retry.ts";
import { publicOrigin } from "../../infra/src/origin.ts";
import { resolveStackName } from "../../infra/src/stack-name.ts";
import { CLOUD_STAGE, Stage } from "../../infra/stages.ts";
import { PASSWORD, Receipt, SignUpReply } from "./warm-up.ts";

/**
 * The note the flow creates and reads back.
 */
const NOTE = { body: "Written by the cloud suite.", id: "n-1", title: "First note" };

/**
 * A note as `GET /api/note/{key}` answers it: its title, body and timestamps.
 */
const NoteRead = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
});

const services = BunHttpClient.layer.pipe(Layer.provideMerge(Digest.layerWebCrypto));

/**
 * A fresh user signed up on the deployed stage and the first note that user created, made once
 * before the cases that read them. Each is a real request to the stage, so the cases that follow
 * send one request apiece. The one-time costs of a new stage were paid by the global setup's
 * `warmUp`, so this setup sends warm requests and runs under the hook's timeout.
 */
class Notebook extends Context.Service<
  Notebook,
  {
    readonly cookie: string;
    readonly origin: string;
    readonly receipt: typeof Receipt.Type;
    readonly userId: string;
  }
>()("@workspace/test/CloudNotebook") {
  static readonly layer = Layer.effect(
    Notebook,
    Effect.gen(function* signUpAndCreate() {
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
        HttpClientRequest.post(`${origin}/api/create-note`).pipe(
          HttpClientRequest.setHeaders({ cookie, origin }),
          HttpClientRequest.bodyJsonUnsafe({
            commandId: crypto.randomUUID(),
            input: NOTE,
            target: user.id,
          }),
        ),
      );

      assert.strictEqual(created.status, 200);

      const receipt = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)));

      return { cookie, origin, receipt, userId: user.id };
    }),
  ).pipe(Layer.provide(services));
}

describe("the deployed notes flow", () => {
  it.layer(Notebook.layer)((cases) => {
    cases.effect(
      "signs a fresh user in and creates the first event of the user's own notebook",
      () =>
        Effect.gen(function* createsNote() {
          const { receipt } = yield* Notebook;

          // The first event of a fresh notebook is version 1.
          assert.strictEqual(receipt.version, 1);
          assert.isTrue(receipt.stream.length > 0);
        }),
    );

    cases.effect("reads the created note back", () =>
      Effect.gen(function* readsNote() {
        const { cookie, origin, receipt, userId } = yield* Notebook;
        const client = retryPlatformNotFound(yield* HttpClient.HttpClient);

        // The Note view keys a note as `<notebook id>~<note id>`; `stream` and `version` make the
        // read wait until the view has applied the create.
        const read = yield* client.execute(
          HttpClientRequest.get(`${origin}/api/note/${userId}~${NOTE.id}`).pipe(
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
      }).pipe(Effect.provide(services)),
    );
  });
});
