import { assert, layer } from "@effect/vitest";
import { Effect, Logger, Redacted, Ref, References } from "effect";
import { emailKey } from "./email-key.ts";
import {
  LocalAuthD1,
  TEST_EMAIL_KEY_SECRET,
  asExecution,
  authOver,
  handle,
  signIn,
  signUp,
} from "./test-harness.ts";

/**
 * One log line as the test logger saw it: the message and the annotations as JSON text.
 */
interface Line {
  readonly annotations: string;
  readonly message: string;
}

/**
 * Run `effect` and collect every log line it writes.
 *
 * @param effect - The effect to run.
 * @returns The lines written.
 */
const collected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* collect() {
    const lines = yield* Ref.make<ReadonlyArray<Line>>([]);

    const logger = Logger.make(({ fiber, message }) => {
      Effect.runSync(
        Ref.update(lines, (all) => [
          ...all,
          {
            annotations: JSON.stringify(fiber.getRef(References.CurrentLogAnnotations)),
            message: JSON.stringify(message),
          },
        ]),
      );
    });

    yield* effect.pipe(Effect.provide(Logger.layer([logger])));
    yield* Effect.yieldNow;

    return yield* Ref.get(lines);
  });

/**
 * The key `bun run log-key` prints for `address` under the test secret.
 *
 * @param address - The address as typed.
 * @returns The hash.
 */
const keyOf = (address: string) => emailKey(Redacted.make(TEST_EMAIL_KEY_SECRET), address);

layer(LocalAuthD1.layer)("the rejected-email log line", (it) => {
  it.effect("carries the keyed hash of a duplicate sign-up, and never the address", () =>
    Effect.gen(function* duplicate() {
      const binding = yield* LocalAuthD1;
      const address = "Grace.Hopper@example.test";

      const lines = yield* collected(
        Effect.gen(function* twice() {
          yield* signUp(address);
          yield* signUp(address);
        }).pipe(Effect.provide(authOver(binding)), asExecution),
      );

      const rejected = lines.filter(({ message }) => message.includes("auth.email.rejected"));
      const key = yield* keyOf(address);

      assert.lengthOf(rejected, 1);
      assert.include(rejected[0]?.annotations, `"emailKey":"${key}"`);
      assert.include(rejected[0]?.annotations, '"path":"/sign-up/email"');
      assert.match(key, /^[0-9a-f]{64}$/u);
      assert.strictEqual(key, yield* keyOf(" grace.hopper@example.test"));
      assert.isFalse(JSON.stringify(lines).toLowerCase().includes("hopper"));
    }),
  );

  it.effect("carries the keyed hash of a wrong password, and nothing for a good sign-in", () =>
    Effect.gen(function* wrongPassword() {
      const binding = yield* LocalAuthD1;
      const address = "margaret.hamilton@example.test";

      const lines = yield* collected(
        Effect.gen(function* attempts() {
          yield* signUp(address);
          yield* signIn(address);
          yield* handle("/auth/sign-in/email", {
            body: JSON.stringify({ email: address, password: "wrong horse battery" }),
            method: "POST",
          });
        }).pipe(Effect.provide(authOver(binding)), asExecution),
      );

      const rejected = lines.filter(({ message }) => message.includes("auth.email.rejected"));

      assert.lengthOf(rejected, 1);
      assert.include(rejected[0]?.annotations, `"emailKey":"${yield* keyOf(address)}"`);
      assert.include(rejected[0]?.annotations, '"path":"/sign-in/email"');
      assert.isFalse(JSON.stringify(lines).toLowerCase().includes("hamilton"));
    }),
  );
});
