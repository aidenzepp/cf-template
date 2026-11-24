import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Logger, Option, Ref } from "effect";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { Scrypt, ScryptError, hashEffect, needsRehash, parse, verifyEffect } from "./password.ts";
import { LocalAuthD1, asExecution, authOver, signIn, signUp } from "./test-harness.ts";

/**
 * The cost of a hash an older deployment stored: cheap, and under today's floors.
 */
const OLDER = { ln: 12, p: 1, r: 8 } as const;

/**
 * The cost every new hash uses.
 */
const CURRENT = AUTH_PASSWORD_SCRYPT.default;

/**
 * Run `effect` and collect every log line it writes.
 *
 * @param effect - The effect to run.
 * @returns The effect's value and the log messages.
 */
const logged = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* collect() {
    const lines = yield* Ref.make<ReadonlyArray<string>>([]);
    const services = yield* Effect.context();

    const logger = Logger.make(({ message }) => {
      Effect.runSyncWith(services)(Ref.update(lines, (all) => [...all, JSON.stringify(message)]));
    });

    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return { lines: yield* Ref.get(lines), value };
  });

layer(Layer.empty)("password hasher", (it) => {
  it.effect("verifies a fresh hash and refuses a wrong password", () =>
    Effect.gen(function* roundTrip() {
      const stored = yield* hashEffect(OLDER, "correct horse");

      assert.match(stored, /^\$scrypt\$ln=12,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/u);
      assert.isTrue(yield* verifyEffect({ hash: stored, password: "correct horse" }));
      assert.isFalse(yield* verifyEffect({ hash: stored, password: "wrong horse" }));
    }),
  );

  it.effect("salts every hash differently", () =>
    Effect.gen(function* salts() {
      const first = yield* hashEffect(OLDER, "same");
      const second = yield* hashEffect(OLDER, "same");

      assert.notStrictEqual(first, second);
    }),
  );

  it.effect.each([
    "$scrypt$ln=12,r=8,p=1$AAAA$AAAA",
    "$scrypt$ln=12,r=8,p=1",
    "00112233445566778899aabbccddeeff:00",
    "",
  ])("answers false and logs auth.password.malformed for %j", (stored) =>
    Effect.gen(function* malformed() {
      const { lines, value } = yield* logged(verifyEffect({ hash: stored, password: "any" }));

      assert.isFalse(value);
      assert.isTrue(lines.some((line) => line.includes("auth.password.malformed")));

      for (const line of lines) {
        assert.notInclude(line, stored.length > 0 ? stored : "\u0000");
      }
    }),
  );

  it.effect("refuses a hash above the 64 MiB ceiling before scrypt runs", () =>
    Effect.gen(function* ceiling() {
      const stored = yield* hashEffect(OLDER, "pw");
      const key = stored.split("$")[4] ?? "";
      const over = `$scrypt$ln=20,r=8,p=1$${stored.split("$")[3] ?? ""}$${key}`;

      const { derive } = Scrypt.defaultValue();
      const calls = yield* Ref.make(0);

      const counting = {
        derive: (...args: Parameters<typeof derive>) =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(derive(...args))),
      };

      const { lines, value } = yield* logged(
        verifyEffect({ hash: over, password: "pw" }).pipe(Effect.provideService(Scrypt, counting)),
      );

      assert.isFalse(value);
      assert.strictEqual(yield* Ref.get(calls), 0);
      assert.isTrue(lines.some((line) => line.includes("auth.password.malformed")));
    }),
  );

  it.effect("refuses a hash over the work ceiling before scrypt runs", () =>
    Effect.gen(function* workCeiling() {
      const stored = yield* hashEffect(OLDER, "pw");
      const parts = stored.split("$");
      const salt = parts[3] ?? "";
      const key = parts[4] ?? "";
      // 19/1/16 fits the 64 MiB memory ceiling but does 2^23 work.
      const over = `$scrypt$ln=19,r=1,p=16$${salt}$${key}`;

      assert.isTrue(Option.isNone(parse(over)));

      const { derive } = Scrypt.defaultValue();
      const calls = yield* Ref.make(0);

      const counting = {
        derive: (...args: Parameters<typeof derive>) =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(derive(...args))),
      };

      const { lines, value } = yield* logged(
        verifyEffect({ hash: over, password: "pw" }).pipe(Effect.provideService(Scrypt, counting)),
      );

      assert.isFalse(value);
      assert.strictEqual(yield* Ref.get(calls), 0);
      assert.isTrue(lines.some((line) => line.includes("auth.password.malformed")));
    }),
  );

  it.effect("parses the default cost and the current floors", () =>
    Effect.gen(function* inside() {
      const stored = yield* hashEffect(CURRENT, "pw");

      assert.isTrue(Option.isSome(parse(stored)));
      assert.isTrue(yield* verifyEffect({ hash: stored, password: "pw" }));
    }),
  );

  it.effect("answers false and logs a fixed event when scrypt fails", () =>
    Effect.gen(function* failing() {
      const stored = yield* hashEffect(OLDER, "pw");

      const broken = {
        derive: () => Effect.fail(new ScryptError({ cause: "secret-cause", keyLength: 64 })),
      };

      const { lines, value } = yield* logged(
        verifyEffect({ hash: stored, password: "pw" }).pipe(Effect.provideService(Scrypt, broken)),
      );

      assert.isFalse(value);
      assert.deepStrictEqual(lines, ['["auth.password.verify_failed"]']);
    }),
  );

  it.effect("parses the parts and compares the cost with the knob", () =>
    Effect.gen(function* costs() {
      const stored = yield* hashEffect(OLDER, "pw");
      const parsed = parse(stored);

      assert.isTrue(Option.isSome(parsed));
      assert.isTrue(Option.isSome(parsed) && parsed.value.salt.length === 16);
      assert.isTrue(Option.isSome(parsed) && parsed.value.key.length === 64);
      assert.isTrue(needsRehash(stored, CURRENT));
      assert.isFalse(needsRehash(stored, OLDER));
      assert.isFalse(needsRehash("salt:key", CURRENT));
    }),
  );
});

layer(LocalAuthD1.layer)("rehash on sign-in", (it) => {
  it.effect("rewrites the stored hash of an older cost to the knob's cost", () =>
    Effect.gen(function* rehash() {
      const binding = yield* LocalAuthD1;
      const email = "rehash@example.test";

      yield* Effect.gen(function* flow() {
        assert.strictEqual((yield* signUp(email)).status, 200);

        const read = Effect.promise(() =>
          binding
            .prepare("SELECT password FROM account WHERE provider_id = 'credential'")
            .first<{ password: string }>(),
        );

        const created = (yield* read)?.password ?? "";

        assert.isFalse(needsRehash(created, CURRENT));

        const older = yield* hashEffect(OLDER, "correct horse battery");

        yield* Effect.promise(() =>
          binding
            .prepare("UPDATE account SET password = ? WHERE provider_id = 'credential'")
            .bind(older)
            .run(),
        );

        assert.strictEqual((yield* signIn(email)).status, 200);

        const after = (yield* read)?.password ?? "";

        assert.notStrictEqual(after, older);
        assert.isFalse(needsRehash(after, CURRENT));
        assert.isTrue(yield* verifyEffect({ hash: after, password: "correct horse battery" }));
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );
});

layer(LocalAuthD1.layer)("rehash compare-and-set", (it) => {
  it.effect("leaves a password changed during the rehash untouched", () =>
    Effect.gen(function* race() {
      const binding = yield* LocalAuthD1;
      const email = "race@example.test";
      const changed = yield* hashEffect(CURRENT, "a newer password");
      const older = yield* hashEffect(OLDER, "correct horse battery");
      const { derive } = Scrypt.defaultValue();
      const calls = yield* Ref.make(0);

      const racing = {
        derive: (...args: Parameters<typeof derive>) =>
          Effect.gen(function* step() {
            const count = yield* Ref.updateAndGet(calls, (n) => n + 1);

            if (count === 2) {
              yield* Effect.promise(() =>
                binding
                  .prepare("UPDATE account SET password = ? WHERE provider_id = 'credential'")
                  .bind(changed)
                  .run(),
              );
            }

            return yield* derive(...args);
          }),
      };

      yield* Effect.gen(function* flow() {
        assert.strictEqual((yield* signUp(email)).status, 200);

        yield* Effect.promise(() =>
          binding
            .prepare("UPDATE account SET password = ? WHERE provider_id = 'credential'")
            .bind(older)
            .run(),
        );

        yield* Ref.set(calls, 0);
        assert.strictEqual((yield* signIn(email)).status, 200);

        const row = yield* Effect.promise(() =>
          binding
            .prepare("SELECT password FROM account WHERE provider_id = 'credential'")
            .first<{ password: string }>(),
        );

        assert.strictEqual(row?.password, changed);
      }).pipe(
        Effect.provide(authOver(binding).pipe(Layer.provide(Layer.succeed(Scrypt, racing)))),
        asExecution,
      );
    }),
  );
});

layer(LocalAuthD1.layer)("sign-in when scrypt fails", (it) => {
  it.effect("answers 401, not a server error", () =>
    Effect.gen(function* failing() {
      const binding = yield* LocalAuthD1;
      const { derive } = Scrypt.defaultValue();
      const calls = yield* Ref.make(0);

      const failAfterSignUp = {
        derive: (...args: Parameters<typeof derive>) =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? derive(...args)
                : Effect.fail(new ScryptError({ cause: "boom", keyLength: 64 })),
            ),
          ),
      };

      yield* Effect.gen(function* flow() {
        assert.strictEqual((yield* signUp("fails@example.test")).status, 200);
        assert.strictEqual((yield* signIn("fails@example.test")).status, 401);
      }).pipe(
        Effect.provide(
          authOver(binding).pipe(Layer.provide(Layer.succeed(Scrypt, failAfterSignUp))),
        ),
        asExecution,
      );
    }),
  );
});
