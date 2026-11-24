import { Effect, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { retryPlatformNotFound } from "../../infra/src/smoke/retry.ts";

/**
 * The password of a throwaway user, long enough for Better Auth's minimum.
 */
export const PASSWORD = "correct horse battery";

/**
 * The slice of a Better Auth sign-up reply the cloud suite reads: the new user's id.
 */
export const SignUpReply = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });

/**
 * The receipt of a Domain command over HTTP: the stream and version the write landed at.
 */
export const Receipt = Schema.Struct({
  reply: Schema.Unknown,
  stream: Schema.String,
  version: Schema.Finite,
});

/**
 * The warm-up request that did not get a 200, so the stage is not serving the notes flow.
 */
class WarmUpFailed extends Schema.TaggedError<WarmUpFailed, { readonly brand: unique symbol }>()(
  "WarmUpFailed",
  {
    message: Schema.String,
  },
) {}

/**
 * Require a 200 from one warm-up request.
 *
 * @param step - What the request did, named in the failure.
 * @param response - The stage's answer.
 * @returns The response, or a {@link WarmUpFailed} quoting the start of the body.
 */
const requireOk = Effect.fn("warmUp.requireOk")(function* requireOk(
  step: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status === 200) {
    return response;
  }

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

  return yield* new WarmUpFailed({
    message: `Warm-up ${step} answered ${response.status}, expected 200: ${body.slice(0, 200)}`,
  });
});

/**
 * Run the notes flow once against a freshly deployed stage as a throwaway user: sign up, create a
 * note, read it back. The first requests to a new stage pay the one-time costs: the edge still
 * answering the platform's not-found page, the first start of each Worker, Durable Object class
 * and D1 query. They can take longer than Vitest's `hookTimeout` of 10 seconds, which a hook that
 * signs up and creates the cases' own note is bound by. A global setup is not bound by it, so the
 * suite pays them here, and the hook then sends warm requests for another user.
 *
 * @param origin - The public origin of the stage, without a trailing slash.
 * @returns Nothing once the read answers 200, or a {@link WarmUpFailed} or the transport failure.
 */
export const warmUp = Effect.fn("warmUp")(function* warmUp(origin: string) {
  const client = retryPlatformNotFound(yield* HttpClient.HttpClient);
  const email = `warm-up-${crypto.randomUUID()}@example.test`;

  const signUp = yield* client
    .execute(
      HttpClientRequest.post(`${origin}/auth/sign-up/email`).pipe(
        HttpClientRequest.setHeader("origin", origin),
        HttpClientRequest.bodyJsonUnsafe({ email, name: "Warm Up", password: PASSWORD }),
      ),
    )
    .pipe(Effect.flatMap((response) => requireOk("sign-up", response)));

  const { user } = yield* signUp.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SignUpReply)));

  const cookie = Cookies.toCookieHeader(signUp.cookies);
  const note = { body: "Written by the warm-up.", id: "warm-up", title: "Warm-up note" };

  const created = yield* client
    .execute(
      HttpClientRequest.post(`${origin}/api/create-note`).pipe(
        HttpClientRequest.setHeaders({ cookie, origin }),
        HttpClientRequest.bodyJsonUnsafe({
          commandId: crypto.randomUUID(),
          input: note,
          target: user.id,
        }),
      ),
    )
    .pipe(Effect.flatMap((response) => requireOk("create-note", response)));

  const receipt = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)));

  yield* client
    .execute(
      HttpClientRequest.get(`${origin}/api/note/${user.id}~${note.id}`).pipe(
        HttpClientRequest.setHeaders({ cookie, origin }),
        HttpClientRequest.setUrlParams({
          stream: receipt.stream,
          version: String(receipt.version),
        }),
      ),
    )
    .pipe(Effect.flatMap((response) => requireOk("note read", response)));
});
