import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import { Mailer } from "./mailer.ts";

/**
 * A log line as the test logger captures it: level, message and every annotation.
 */
interface Captured {
  readonly annotations: typeof References.CurrentLogAnnotations.Service;
  readonly level: string;
  readonly message: unknown;
}

/**
 * Run `effect` and collect every log line it writes.
 *
 * @param effect - The effect to run.
 * @returns The effect's value and the captured lines.
 */
const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* collect() {
    const lines: Array<Captured> = [];

    const logger = Logger.make(({ fiber, logLevel, message }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);

      lines.push({
        annotations,
        level: logLevel,
        message: Array.isArray(message) ? message[0] : message,
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

  it.effect("sends nothing and writes one mailer.none warning with the subject only", () =>
    Effect.gen(function* sends() {
      const { lines } = yield* capture(
        Mailer.use(({ send }) => send({ subject: "Reset", text: "secret body", to: "a@b.test" })),
      );

      assert.deepStrictEqual(lines, [
        { annotations: { subject: "Reset" }, level: "Warn", message: "mailer.none" },
      ]);
      assert.isFalse(JSON.stringify(lines).includes("a@b.test"));
      assert.isFalse(JSON.stringify(lines).includes("secret body"));
    }),
  );
});
