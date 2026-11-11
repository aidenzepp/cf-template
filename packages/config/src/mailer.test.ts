import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import { Mailer } from "./mailer.ts";

/**
 * A log line as the test logger captures it: level, message and the two annotations.
 */
interface Captured {
  readonly level: string;
  readonly message: unknown;
  readonly subject: unknown;
  readonly to: unknown;
}

/**
 * Run `effect` and collect every log line it writes.
 *
 * @param effect - The effect to run.
 * @returns The effect's value and the captured lines.
 */
const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* collect() {
    const lines: Captured[] = [];

    const logger = Logger.make(({ fiber, logLevel, message }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);

      lines.push({
        level: logLevel,
        message: Array.isArray(message) ? message[0] : message,
        subject: annotations.subject,
        to: annotations.to,
      });
    });

    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return { lines, value };
  });

describe("Mailer", () => {
  it.effect("answers with Mailer.None when no provider is supplied", () =>
    Effect.gen(function* defaults() {
      const mailer = yield* Mailer;

      assert.strictEqual(mailer, Mailer.None);
    }),
  );

  it.effect("sends nothing and writes one mailer.none warning with the recipient and subject", () =>
    Effect.gen(function* sends() {
      const { lines } = yield* capture(
        Mailer.use(({ send }) => send({ subject: "Reset", text: "secret body", to: "a@b.test" })),
      );

      assert.deepStrictEqual(lines, [
        { level: "Warn", message: "mailer.none", subject: "Reset", to: "a@b.test" },
      ]);
    }),
  );
});
