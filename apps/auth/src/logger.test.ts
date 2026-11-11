import { assert, it, layer } from "@effect/vitest";
import { Effect, Logger, Ref, References } from "effect";
import { betterAuthLogger, redactEmails } from "./logger.ts";
import type { LogArgument } from "./logger.ts";
import { LocalAuthD1, asExecution, authOver, signUp } from "./test-harness.ts";

/**
 * One log line as the test logger saw it: the level, and the message and annotations as JSON text.
 */
interface Line {
  readonly annotations: string;
  readonly level: string;
  readonly message: string;
}

/**
 * Run `effect` and collect every log line it writes.
 *
 * @param effect - The effect to run.
 * @returns The effect's value and the lines written.
 */
const collected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* collect() {
    const lines = yield* Ref.make<ReadonlyArray<Line>>([]);

    const logger = Logger.make(({ fiber, logLevel, message }) => {
      Effect.runSync(
        Ref.update(lines, (all) => [
          ...all,
          {
            annotations: JSON.stringify(fiber.getRef(References.CurrentLogAnnotations)),
            level: logLevel,
            message: JSON.stringify(message),
          },
        ]),
      );
    });

    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return { lines: yield* Ref.get(lines), value };
  });

/**
 * Send one message through the Better Auth logger and collect what the Effect logger receives.
 *
 * @param level - The Better Auth level.
 * @param message - The message.
 * @param args - The extra arguments.
 * @returns The lines written.
 */
const logged = (
  level: "warn" | "error",
  message: string,
  ...args: ReadonlyArray<LogArgument>
): Effect.Effect<ReadonlyArray<Line>> =>
  Effect.gen(function* write() {
    const { lines } = yield* collected(
      Effect.gen(function* emit() {
        const services = yield* Effect.context();

        betterAuthLogger((effect) => {
          Effect.runForkWith(services)(effect);
        }).log(level, message, ...args);

        yield* Effect.yieldNow;
      }),
    );

    return lines;
  });

layer(LocalAuthD1.layer)("the Better Auth logger", (live) => {
  live.effect("publishes no line at the default level when an address signs up twice", () =>
    Effect.gen(function* duplicate() {
      const binding = yield* LocalAuthD1;

      const { lines } = yield* collected(
        Effect.gen(function* twice() {
          yield* signUp("ada.lovelace@example.com");
          yield* signUp("ada.lovelace@example.com");
          yield* Effect.yieldNow;
        }).pipe(
          Effect.provide(authOver(binding, { AUTH_METHODS: '{"email":true,"providers":[]}' })),
          asExecution,
        ),
      );

      assert.isFalse(lines.some((line) => JSON.stringify(line).includes("ada.lovelace")));
      assert.isFalse(
        lines.some((line) => JSON.stringify(line).includes("Sign-up attempt for existing email")),
      );
    }),
  );

  it.effect("redacts an address in a warn message and keeps its level", () =>
    Effect.gen(function* warning() {
      const lines = yield* logged("warn", "Rejected ada@example.com", "from ada@example.com");

      assert.deepStrictEqual(
        lines.map(({ level, message }) => ({ level, message })),
        [{ level: "Warn", message: '["Rejected [email] from [email]"]' }],
      );
    }),
  );

  it.effect("redacts an address split across two arguments", () =>
    Effect.gen(function* split() {
      const trailing = yield* logged("error", "Failed for", "ada@", "example.com");
      const leading = yield* logged("error", "Failed for", "ada", "@example.com");

      assert.deepStrictEqual(
        [...trailing, ...leading].map(({ message }) => message),
        ['["Failed for [email] [email]"]', '["Failed for [email] [email]"]'],
      );
    }),
  );

  it.effect("annotates an object argument with its string fields redacted", () =>
    Effect.gen(function* structured() {
      const lines = yield* logged("error", "Mail failed", {
        attempts: 2,
        to: ["bob@private-domain.net"],
      });

      assert.deepStrictEqual(
        lines.map(({ annotations }) => annotations),
        ['{"args":[{"attempts":2,"to":["[email]"]}]}'],
      );
    }),
  );

  it.effect("keeps an error's message, stack and cause, redacted", () =>
    Effect.gen(function* failing() {
      const error = new Error("duplicate ada@example.com", {
        cause: new Error("row ada@example.com"),
      });

      const lines = yield* logged("error", "Failed to create user", error);
      const [{ annotations, message } = { annotations: "", message: "" }] = lines;

      assert.strictEqual(message, '["Failed to create user duplicate [email]"]');
      assert.include(annotations, '"message":"duplicate [email]"');
      assert.include(annotations, '"stack":"Error: duplicate [email]');
      assert.include(annotations, '"cause":{"cause":null,"message":"row [email]"');
      assert.isFalse(JSON.stringify(lines).includes("ada@"));
    }),
  );

  it("leaves no fragment of a list, a JSON document or a quoted local part", () => {
    assert.strictEqual(redactEmails("a@b.co,c@d.io"), "[email]");
    assert.strictEqual(redactEmails('{"from":"a@x.com","to":"bob@private-domain.net"}'), "[email]");
    assert.strictEqual(
      redactEmails('sent to "ada lovelace"@example.com today'),
      "sent to [email] today",
    );
  });
});
