import { assert, it, layer } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Logger, Ref, References, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { makeDatabase } from "@workspace/db/database";
import type { RawDatabase } from "@workspace/db/database";
import { AUTH_ORPHAN_GRACE_SECONDS } from "@workspace/config/auth-orphan-grace";
import { deleteOrphan } from "./reclaim.ts";
import { LocalAuthD1, asExecution, authOver, signUp } from "./test-harness.ts";

/**
 * The bindings that turn the mail add-in on, so Better Auth heals orphans itself.
 */
const EMAIL_ON = { AUTH_METHODS: '{"email":true,"providers":[]}' };

/**
 * One log line the instance wrote: its message and annotations.
 */
interface Line {
  readonly ageSeconds: unknown;
  readonly message: string;
  readonly userId: unknown;
}

/**
 * Run `effect` and collect every log line and every span it starts.
 *
 * @param effect - The effect to run.
 * @returns The effect's value, the log lines and the spans.
 */
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* observe() {
    const lines = yield* Ref.make<ReadonlyArray<Line>>([]);
    const services = yield* Effect.context();
    const spans: Array<Tracer.NativeSpan> = [];

    const logger = Logger.make(({ fiber, message }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);

      Effect.runSyncWith(services)(
        Ref.update(lines, (all) => [
          ...all,
          {
            ageSeconds: annotations.ageSeconds,
            message: JSON.stringify(message),
            userId: annotations.userId,
          },
        ]),
      );
    });

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    const value = yield* effect.pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Tracer.Tracer, tracer),
    );

    return { lines: yield* Ref.get(lines), spans, value };
  });

/**
 * Make every write to `account` fail while `effect` runs, so a sign-up writes its `user` row and
 * then fails on the `account` row: the half-written state D1 cannot roll back. The adapter fails
 * on its own second write; no row is inserted by hand.
 *
 * @param binding - The binding.
 * @param effect - The effect to run with the failing `account` writes.
 * @returns The effect's value, with the trigger dropped afterwards.
 */
const withFailingAccountWrites = <A, E, R>(binding: RawDatabase, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      binding.exec(
        "create trigger fail_account before insert on account begin select raise(abort, 'forced'); end",
      ),
    ),
    () => effect,
    () => Effect.promise(() => binding.exec("drop trigger fail_account")),
  );

/**
 * The stored row count for an address.
 *
 * @param binding - The binding.
 * @param email - The stored (lowercase) address.
 * @returns How many `user` rows carry it.
 */
const rowsFor = (binding: RawDatabase, email: string) =>
  Effect.promise(() =>
    binding
      .prepare("select count(*) as n from user where email = ?")
      .bind(email)
      .first<{ readonly n: number }>(),
  ).pipe(Effect.map((row) => row?.n));

/**
 * Create the orphan of `email` the only way the product can: a sign-up whose `account` write fails.
 *
 * @param binding - The healthy binding.
 * @param email - The address to sign up.
 * @returns The id of the stranded `user` row.
 */
const orphanOf = (binding: RawDatabase, email: string) =>
  Effect.gen(function* strand() {
    const response = yield* withFailingAccountWrites(
      binding,
      signUp(email).pipe(Effect.provide(authOver(binding)), asExecution),
    );

    assert.notStrictEqual(response.status, 200);
    assert.strictEqual(yield* rowsFor(binding, email), 1);

    const row = yield* Effect.promise(() =>
      binding
        .prepare("select id from user where email = ?")
        .bind(email)
        .first<{ readonly id: string }>(),
    );

    assert.isNotNull(row);

    return row?.id ?? "";
  });

/**
 * Run a sign-up retry for `submitted` once the clock stands `ageSeconds` past the real time.
 *
 * @param binding - The healthy binding.
 * @param submitted - The address as the retry submits it.
 * @param ageSeconds - How far past now the instance's clock stands.
 * @param overrides - Deployment bindings that replace the defaults.
 * @returns The retry's status, the log lines and the spans.
 */
const retry = (
  binding: RawDatabase,
  submitted: string,
  ageSeconds: number,
  overrides?: Readonly<Record<string, string>>,
) =>
  observed(
    Effect.gen(function* attempt() {
      yield* TestClock.setTime(Date.now() + ageSeconds * 1000);

      return (yield* signUp(submitted)).status;
    }).pipe(Effect.provide(authOver(binding, overrides)), asExecution),
  );

/**
 * The reclaim log lines among `lines`.
 *
 * @param lines - Every line written.
 * @returns The lines named `auth.orphan.reclaim`.
 */
const reclaims = (lines: ReadonlyArray<Line>) =>
  lines.filter((line) => line.message === '["auth.orphan.reclaim"]');

/**
 * The timeout of the guarded-delete test, which strands seven orphans, each a real sign-up that
 * hashes a password: under 2 s alone, more than the 5 s default on a loaded machine.
 */
const SIGN_UP_TIMEOUT_MS = 60_000;

layer(LocalAuthD1.layer)("the orphan reclaim hook", (live) => {
  live.effect("keeps a verified orphan", () =>
    Effect.gen(function* verified() {
      const binding = yield* LocalAuthD1;

      yield* orphanOf(binding, "verified@example.com");
      yield* Effect.promise(() =>
        binding
          .prepare("update user set email_verified = 1 where email = ?")
          .bind("verified@example.com")
          .run(),
      );

      const { lines } = yield* retry(binding, "verified@example.com", 3600);

      assert.strictEqual(yield* rowsFor(binding, "verified@example.com"), 1);
      assert.lengthOf(reclaims(lines), 0);
    }),
  );

  live.effect("keeps an unverified orphan inside the grace", () =>
    Effect.gen(function* inside() {
      const binding = yield* LocalAuthD1;

      yield* orphanOf(binding, "young@example.com");

      const { lines } = yield* retry(binding, "young@example.com", 300);

      assert.strictEqual(yield* rowsFor(binding, "young@example.com"), 1);
      assert.lengthOf(reclaims(lines), 0);
    }),
  );

  live.effect("reclaims an unverified orphan outside the grace and lets the retry sign up", () =>
    Effect.gen(function* outside() {
      const binding = yield* LocalAuthD1;
      const id = yield* orphanOf(binding, "old@example.com");

      const { lines, spans, value } = yield* retry(binding, "old@example.com", 601);

      assert.strictEqual(value, 200);
      assert.strictEqual(yield* rowsFor(binding, "old@example.com"), 1);

      const logged = reclaims(lines);
      const span = spans.filter((candidate) => candidate.name === "auth.orphan.reclaim");

      assert.lengthOf(logged, 1);
      assert.lengthOf(span, 1);
      assert.strictEqual(logged[0]?.userId, id);
      assert.isAtLeast(Number(logged[0]?.ageSeconds), 601);
      assert.strictEqual(span[0]?.attributes.get("userId"), id);
      assert.isAtLeast(Number(span[0]?.attributes.get("ageSeconds")), 601);
      assert.notInclude(
        JSON.stringify([lines, [...(span[0]?.attributes ?? [])]]),
        "old@example.com",
      );
    }),
  );

  live.effect("keeps an unverified row that holds a passkey", () =>
    Effect.gen(function* passkeyHeld() {
      const binding = yield* LocalAuthD1;
      const id = yield* orphanOf(binding, "passkey-held@example.com");

      yield* Effect.promise(() =>
        binding
          .prepare(
            "insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ('pk-1', 'key', ?, 'cred', 0, 'singleDevice', 0)",
          )
          .bind(id)
          .run(),
      );

      const { lines } = yield* retry(binding, "passkey-held@example.com", 3600);

      assert.strictEqual(yield* rowsFor(binding, "passkey-held@example.com"), 1);
      assert.lengthOf(reclaims(lines), 0);
    }),
  );

  live.effect("does nothing while the mail add-in is on", () =>
    Effect.gen(function* mailOn() {
      const binding = yield* LocalAuthD1;

      yield* orphanOf(binding, "mail-on@example.com");

      const { lines } = yield* retry(binding, "mail-on@example.com", 3600, EMAIL_ON);

      assert.strictEqual(yield* rowsFor(binding, "mail-on@example.com"), 1);
      assert.lengthOf(reclaims(lines), 0);
    }),
  );

  live.effect(
    "reclaims the lowercase row for a mixed-case address and lets the retry sign up",
    () =>
      Effect.gen(function* mixedCase() {
        const binding = yield* LocalAuthD1;

        yield* orphanOf(binding, "mixed@example.com");

        const { lines, value } = yield* retry(binding, "Mixed@Example.COM", 601);

        assert.strictEqual(value, 200);
        assert.lengthOf(reclaims(lines), 1);
      }),
  );

  live.effect("deletes nothing for a padded address, which Better Auth does not trim", () =>
    Effect.gen(function* padded() {
      const binding = yield* LocalAuthD1;

      yield* orphanOf(binding, "padded@example.com");

      const { lines, value } = yield* retry(binding, "  padded@example.com ", 3600);

      assert.notStrictEqual(value, 200);
      assert.strictEqual(yield* rowsFor(binding, "padded@example.com"), 1);
      assert.lengthOf(reclaims(lines), 0);
    }),
  );

  live.effect(
    "the guarded delete keeps a row unless every guard holds",
    () =>
      Effect.gen(function* guards() {
        const binding = yield* LocalAuthD1;

        const run = (statement: string, ...values: ReadonlyArray<string>) =>
          Effect.promise(() =>
            binding
              .prepare(statement)
              .bind(...values)
              .run(),
          );

        const attempt = (id: string, overrides: Partial<Parameters<typeof deleteOrphan>[1]>) =>
          Effect.gen(function* delete_() {
            const access = yield* makeDatabase(binding);
            const { db } = yield* access;

            return yield* deleteOrphan(db, {
              address: "never@example.com",
              cutoff: new Date(Date.now() + 60_000),
              id,
              ...overrides,
            });
          }).pipe(asExecution);

        const fresh = (name: string) =>
          orphanOf(binding, `${name}@example.com`).pipe(
            Effect.map((id) => ({ address: `${name}@example.com`, id })),
          );

        const kept = (name: string, id: string) =>
          rowsFor(binding, `${name}@example.com`).pipe(
            Effect.tap((rows) =>
              Effect.sync(() => {
                assert.strictEqual(rows, 1, `${name}: ${id}`);
              }),
            ),
          );

        const verified = yield* fresh("guard-verified");

        yield* run("update user set email_verified = 1 where id = ?", verified.id);
        assert.lengthOf(yield* attempt(verified.id, { address: verified.address }), 0);
        yield* kept("guard-verified", verified.id);

        const old = yield* fresh("guard-age");

        assert.lengthOf(
          yield* attempt(old.id, {
            address: old.address,
            cutoff: new Date(Date.now() - 3_600_000),
          }),
          0,
        );
        yield* kept("guard-age", old.id);

        const withAccount = yield* fresh("guard-account");

        yield* run(
          "insert into account (id, account_id, provider_id, user_id, updated_at) values ('guard-acc', 'x', 'credential', ?, 0)",
          withAccount.id,
        );
        assert.lengthOf(yield* attempt(withAccount.id, { address: withAccount.address }), 0);
        yield* kept("guard-account", withAccount.id);

        const withPasskey = yield* fresh("guard-passkey");

        yield* run(
          "insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ('guard-pk', 'key', ?, 'guard-cred', 0, 'singleDevice', 0)",
          withPasskey.id,
        );
        assert.lengthOf(yield* attempt(withPasskey.id, { address: withPasskey.address }), 0);
        yield* kept("guard-passkey", withPasskey.id);

        const otherId = yield* fresh("guard-id");

        assert.lengthOf(yield* attempt("not-this-id", { address: otherId.address }), 0);
        yield* kept("guard-id", otherId.id);

        const otherAddress = yield* fresh("guard-address");

        assert.lengthOf(
          yield* attempt(otherAddress.id, { address: "someone-else@example.com" }),
          0,
        );
        yield* kept("guard-address", otherAddress.id);

        const control = yield* fresh("guard-control");

        assert.deepStrictEqual(
          (yield* attempt(control.id, { address: control.address })).map((row) => row.id),
          [control.id],
        );
        assert.strictEqual(yield* rowsFor(binding, control.address), 0);
      }),
    SIGN_UP_TIMEOUT_MS,
  );
});

/**
 * Read the grace knob from a supplied environment and return the failure.
 *
 * @param value - The supplied bindings.
 * @returns The `ConfigError` the read fails with.
 */
const readFailure = (value: Readonly<Record<string, string>>) =>
  AUTH_ORPHAN_GRACE_SECONDS.config.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(value))),
    Effect.flip,
  );

it.effect("bounds the grace between 60 and 3600 seconds and defaults to 600", () =>
  Effect.gen(function* knob() {
    assert.instanceOf(yield* readFailure({ AUTH_ORPHAN_GRACE_SECONDS: "59" }), Config.ConfigError);
    assert.instanceOf(
      yield* readFailure({ AUTH_ORPHAN_GRACE_SECONDS: "3601" }),
      Config.ConfigError,
    );

    assert.strictEqual(
      yield* AUTH_ORPHAN_GRACE_SECONDS.config.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
      600,
    );
  }),
);
