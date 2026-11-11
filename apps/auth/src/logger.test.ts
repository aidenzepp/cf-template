import { assert, it, layer } from "@effect/vitest";
import { Effect, Logger, Ref } from "effect";
import { betterAuthLogger, redactEmails } from "./logger.ts";
import { LocalAuthD1, asExecution, authOver, signUp } from "./test-harness.ts";

/**
 * Run `effect` and collect every log line as `level: message` text.
 *
 * @param effect - The effect to run.
 * @returns The effect's value and the lines written.
 */
const collected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* collect() {
    const lines = yield* Ref.make<ReadonlyArray<string>>([]);

    const logger = Logger.make(({ logLevel, message }) => {
      Effect.runSync(
        Ref.update(lines, (all) => [...all, `${logLevel}: ${JSON.stringify(message)}`]),
      );
    });

    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return { lines: yield* Ref.get(lines), value };
  });

layer(LocalAuthD1.layer)("the Better Auth logger", (live) => {
  live.effect("keeps the address of a duplicate sign-up out of the log", () =>
    Effect.gen(function* duplicate() {
      const binding = yield* LocalAuthD1;
      const address = "ada.lovelace@example.com";

      const { lines } = yield* collected(
        Effect.gen(function* twice() {
          yield* signUp(address);
          yield* signUp(address);
          yield* Effect.yieldNow;
        }).pipe(
          Effect.provide(authOver(binding, { AUTH_METHODS: '{"email":true,"providers":[]}' })),
          asExecution,
        ),
      );

      assert.isTrue(lines.some((line) => line.includes("Sign-up attempt for existing email")));
      assert.isFalse(lines.some((line) => line.includes("ada.lovelace")));
    }),
  );

  it.effect("passes an error-level message through with its address redacted", () =>
    Effect.gen(function* failing() {
      const { lines } = yield* collected(
        Effect.gen(function* write() {
          const services = yield* Effect.context();

          betterAuthLogger((effect) => {
            Effect.runForkWith(services)(effect);
          }).log("error", "Failed to create user", new Error("duplicate ada@example.com"));

          yield* Effect.yieldNow;
        }),
      );

      assert.deepStrictEqual(lines, ['Error: ["Failed to create user duplicate [email]"]']);
    }),
  );

  it("replaces every email-shaped substring", () => {
    assert.strictEqual(redactEmails("a@b.co and c@d.io"), "[email] and [email]");
  });
});
