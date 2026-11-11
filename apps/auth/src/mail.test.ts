import { assert, layer } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import type { Mailer } from "@workspace/config/mailer";
import { MailerError } from "@workspace/config/mailer";
import { LocalAuthD1, asExecution, authOver, handle, signUp } from "./test-harness.ts";

/**
 * Ask for a password reset mail for `email` and read the response.
 *
 * @param email - The address in the request body.
 * @returns The status and the parsed body.
 */
const requestReset = (email: string) =>
  Effect.gen(function* request() {
    const response = yield* handle("/auth/request-password-reset", {
      body: JSON.stringify({ email }),
      method: "POST",
    });

    return { body: yield* Effect.promise(() => response.text()), status: response.status };
  });

layer(LocalAuthD1.layer)("the reset mail", (live) => {
  live.effect("answers an existing and a missing account alike when the mailer fails", () =>
    Effect.gen(function* failing() {
      const binding = yield* LocalAuthD1;
      const attempts = yield* Ref.make(0);

      const mailer: typeof Mailer.None = {
        send: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(new MailerError({ cause: "boom", message: "failed" }))),
          ),
      };

      const answers = yield* Effect.gen(function* inner() {
        yield* signUp("known@example.com");

        const known = yield* requestReset("known@example.com");
        const missing = yield* requestReset("missing@example.com");

        return { known, missing };
      }).pipe(Effect.provide(authOver(binding, undefined, mailer)), asExecution);

      assert.strictEqual(answers.known.status, 200);
      assert.deepStrictEqual(answers.known, answers.missing);
      assert.strictEqual(yield* Ref.get(attempts), 1);
    }),
  );

  live.effect("does not wait for the mailer before it answers", () =>
    Effect.gen(function* slow() {
      const binding = yield* LocalAuthD1;
      const release = yield* Deferred.make<string>();
      const started = yield* Deferred.make<string>();

      const mailer: typeof Mailer.None = {
        send: () =>
          Deferred.succeed(started, "started").pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          ),
      };

      const answered = yield* Effect.gen(function* inner() {
        yield* signUp("slow@example.com");

        const response = yield* requestReset("slow@example.com");

        yield* Deferred.await(started);
        yield* Deferred.succeed(release, "released");

        return response;
      }).pipe(Effect.provide(authOver(binding, undefined, mailer)), asExecution);

      assert.strictEqual(answered.status, 200);
    }),
  );
});
