import { assert, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { RawDatabase } from "@workspace/db/database";
import { ENDPOINT_CLASSES } from "./contract.ts";
import {
  BETTER_AUTH_FRESH_PATHS,
  EXEMPT_FROM_FRESHNESS,
  FRESH_SESSION_PATHS,
} from "./fresh-session.ts";
import {
  LocalAuthD1,
  asExecution,
  authOver,
  cookieOf,
  handle,
  signIn,
  signUp,
  tokenOnly,
} from "./test-harness.ts";

/**
 * The default `session.freshAge` of Better Auth, in milliseconds, which this instance keeps.
 */
const FRESH_AGE_MS = 86_400_000;

const ErrorBody = Schema.Struct({ code: Schema.optional(Schema.String) });

/**
 * Post an empty body to an endpoint with `cookie`.
 *
 * @param path - The endpoint, relative to the auth base path.
 * @param cookie - The `Cookie` header to send.
 * @returns The response status and its JSON error code, if any.
 */
const post = (path: string, cookie: string) =>
  Effect.gen(function* send() {
    const response = yield* handle(`/auth${path}`, {
      body: "{}",
      headers: { cookie },
      method: "POST",
    });

    const body = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
      Effect.orElseSucceed(() => ({ code: undefined })),
    );

    return { code: body.code, status: response.status };
  });

/**
 * Set the stored session's `created_at`, which is its age.
 *
 * @param binding - The D1 binding.
 * @param at - The creation time in milliseconds.
 * @returns An effect that updates every session row.
 */
const setCreatedAt = (binding: RawDatabase, at: number) =>
  Effect.promise(() => binding.prepare("UPDATE session SET created_at = ?").bind(at).run());

/**
 * Sign up and in a user and return the stored-session cookie.
 *
 * @param email - The user's email.
 * @returns The cookie without `session_data`, so Better Auth reads the session row.
 */
const signedIn = (email: string) =>
  Effect.gen(function* start() {
    yield* signUp(email);

    return tokenOnly(cookieOf(yield* signIn(email)));
  });

layer(LocalAuthD1.layer)("fresh session on account-changing calls", (it) => {
  it.effect.each([...FRESH_SESSION_PATHS])(
    "%s refuses a stale session, allows a fresh one and refuses no session",
    (path) =>
      Effect.gen(function* gate() {
        const binding = yield* LocalAuthD1;

        return yield* Effect.gen(function* flow() {
          const cookie = yield* signedIn(`${path.replaceAll("/", "-").slice(1)}@example.test`);

          // Stale first: a fresh call to `/revoke-sessions` would end the session.
          yield* setCreatedAt(binding, Date.now() - FRESH_AGE_MS - 1000);

          const stale = yield* post(path, cookie);

          assert.strictEqual(stale.status, 403);
          assert.strictEqual(stale.code, "SESSION_NOT_FRESH");

          yield* setCreatedAt(binding, Date.now());

          const fresh = yield* post(path, cookie);

          assert.notStrictEqual(fresh.code, "SESSION_NOT_FRESH");
          assert.notStrictEqual(fresh.status, 401);
          assert.notStrictEqual(fresh.status, 403);

          const anonymous = yield* post(path, "");

          assert.strictEqual(anonymous.status, 401);
        }).pipe(Effect.provide(authOver(binding)), asExecution);
      }),
  );

  it.effect("does not gate an endpoint outside the list: a stale session still reaches it", () =>
    Effect.gen(function* control() {
      const binding = yield* LocalAuthD1;

      return yield* Effect.gen(function* flow() {
        const cookie = yield* signedIn("control@example.test");

        yield* setCreatedAt(binding, Date.now() - FRESH_AGE_MS - 1000);

        const stale = yield* post("/update-session", cookie);

        assert.notStrictEqual(stale.code, "SESSION_NOT_FRESH");
        assert.notStrictEqual(stale.status, 401);
        assert.notStrictEqual(stale.status, 403);
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );
});

layer(LocalAuthD1.layer)("freshness classification", (it) => {
  it.effect("puts every endpoint in exactly one of: our hook, Better Auth, exempt", () =>
    Effect.sync(() => {
      const groups = [
        [...FRESH_SESSION_PATHS],
        [...BETTER_AUTH_FRESH_PATHS],
        Object.keys(EXEMPT_FROM_FRESHNESS),
      ];

      const all = groups.flat();

      assert.deepStrictEqual(all.toSorted(), Object.keys(ENDPOINT_CLASSES).toSorted());
      assert.strictEqual(new Set(all).size, all.length);
      assert.isTrue(Object.values(EXEMPT_FROM_FRESHNESS).every((reason) => reason.length > 0));
    }),
  );
});
