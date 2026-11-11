import { BunServices } from "@effect/platform-bun";
import { assert, layer, vi } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { EffectSQLiteD1Database } from "drizzle-orm/effect-d1";
import { Effect, FileSystem, Option, Path, Schema, Tracer } from "effect";
import { makeDatabase } from "@workspace/db/database";
import { AuthService, adapterOptions } from "./auth.ts";
import {
  LocalAuthD1,
  asExecution,
  authOver,
  cookieOf,
  handle,
  tokenOnly,
  signIn,
  signUp,
} from "./test-harness.ts";

/**
 * The packages the promise view is proven against. The test fails when `apps/auth/package.json`
 * pins a different version, so a bump re-reads this contract.
 */
const PINNED = {
  "@better-auth/drizzle-adapter": "1.7.19",
  "better-auth": "1.7.19",
  "drizzle-orm": "1.0.0-rc.5",
} as const;

/**
 * The version `@effect/sql-d1` is overridden to at the repository root.
 */
const SQL_D1 = "4.1.2";

/**
 * Run `effect` with a tracer that records every span it starts.
 *
 * @param effect - The effect to trace.
 * @returns The effect's value and the spans it started, in start order.
 */
const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* record() {
    const spans: Tracer.NativeSpan[] = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    const value = yield* effect.pipe(Effect.provideService(Tracer.Tracer, tracer));

    return { spans, value };
  });

/**
 * The body of `GET /auth/get-session`: `null` when signed out, else the session with its user.
 */
const SessionBody = Schema.NullOr(Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }));

/**
 * Read and decode the JSON body of a `get-session` response.
 *
 * @param response - A `get-session` response.
 * @returns The decoded body.
 */
const json = (response: Response) =>
  Effect.promise(() => response.text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SessionBody))),
  );

layer(LocalAuthD1.layer)("the Better Auth promise view", (it) => {
  it.effect("passes the E4 flow: sign-up, sign-in, session and sign-out", () =>
    Effect.gen(function* e4() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* flow() {
        assert.strictEqual((yield* signUp("e4@example.test")).status, 200);

        const signedIn = yield* signIn("e4@example.test");

        assert.strictEqual(signedIn.status, 200);

        const cookie = cookieOf(signedIn);
        const session = yield* handle("/auth/get-session", { headers: { cookie }, method: "GET" });

        assert.strictEqual((yield* json(session))?.user.email, "e4@example.test");

        const signedOut = yield* handle("/auth/sign-out", {
          body: "{}",
          headers: { cookie },
          method: "POST",
        });

        assert.strictEqual(signedOut.status, 200);

        const after = yield* handle("/auth/get-session", {
          headers: { cookie: cookieOf(signedOut) },
          method: "GET",
        });

        assert.isNull(yield* json(after));

        // The old session token alone cannot be answered from the cookie cache, so a null here
        // means the server revoked the session row.
        const revoked = yield* handle("/auth/get-session", {
          headers: { cookie: tokenOnly(cookie) },
          method: "GET",
        });

        assert.isNull(yield* json(revoked));
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );

  it.effect("reads one row through the adapter with every SQL span under the request span", () =>
    Effect.gen(function* e7() {
      const binding = yield* LocalAuthD1;

      const { spans } = yield* traced(
        Effect.gen(function* request() {
          const instance = yield* (yield* yield* AuthService).auth;
          const context = yield* Effect.promise(() => instance.$context);

          return yield* Effect.promise(() =>
            context.adapter.findOne({
              model: "user",
              where: [{ field: "email", value: "nobody@example.test" }],
            }),
          );
        }).pipe(Effect.withSpan("request"), Effect.provide(authOver(binding)), asExecution),
      );

      const request = spans.find((span) => span.name === "request");

      const queries = spans.filter(
        (span) => span.name !== "request" && span.name.startsWith("sql"),
      );

      assert.isDefined(request);
      assert.isAbove(queries.length, 0);

      for (const span of queries) {
        assert.strictEqual(
          span.parent.pipe(
            Option.map((parent) => parent.spanId),
            Option.getOrUndefined,
          ),
          request?.spanId,
          `${span.name} is not parented to the request span`,
        );
      }
    }),
  );

  it.effect("trusts only cf-connecting-ip for the client address", () =>
    Effect.gen(function* trust() {
      const binding = yield* LocalAuthD1;

      return yield* Effect.gen(function* read() {
        const instance = yield* (yield* yield* AuthService).auth;
        const context = yield* Effect.promise(() => instance.$context);

        assert.deepStrictEqual(context.options.advanced?.ipAddress?.ipAddressHeaders, [
          "cf-connecting-ip",
        ]);
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );

  it.effect("loses the request span under a bare runPromise, the control", () =>
    Effect.gen(function* control() {
      const binding = yield* LocalAuthD1;

      const { spans } = yield* traced(
        Effect.gen(function* request() {
          const access = yield* makeDatabase(binding);
          const { db } = yield* access;
          const tracer = yield* Tracer.Tracer;

          // A bare `runPromise` starts a fiber with no parent span; only the tracer is carried over
          // so the span is still recorded.
          yield* Effect.promise(() =>
            Effect.runPromise(
              db.run(sql`select 1`).pipe(Effect.provideService(Tracer.Tracer, tracer)),
            ),
          );
        }).pipe(Effect.withSpan("request"), asExecution),
      );

      const request = spans.find((span) => span.name === "request");
      const orphans = spans.filter((span) => span.name !== "request" && Option.isNone(span.parent));

      assert.isDefined(request);
      assert.isAbove(orphans.length, 0);
    }),
  );

  it.effect("never calls db.transaction", () =>
    Effect.gen(function* noTransaction() {
      const binding = yield* LocalAuthD1;
      const transaction = vi.spyOn(EffectSQLiteD1Database.prototype, "transaction");

      yield* Effect.gen(function* flow() {
        yield* signUp("tx@example.test");
        yield* signIn("tx@example.test");
      }).pipe(
        Effect.provide(authOver(binding)),
        asExecution,
        Effect.ensuring(
          Effect.sync(() => {
            transaction.mockRestore();
          }),
        ),
      );

      assert.strictEqual(transaction.mock.calls.length, 0);
    }),
  );

  it.effect("passes transaction: false to the adapter and names the pinned packages", () =>
    Effect.gen(function* contract() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const manifest = yield* fs.readFileString(path.join(root, "package.json"));
      const rootManifest = yield* fs.readFileString(path.join(root, "../../package.json"));

      assert.strictEqual(adapterOptions.transaction, false);
      assert.strictEqual(adapterOptions.provider, "sqlite");

      for (const [name, version] of Object.entries(PINNED)) {
        assert.include(manifest, `"${name}": "${version}"`);
      }

      assert.include(rootManifest, `"@effect/sql-d1": "${SQL_D1}"`);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
