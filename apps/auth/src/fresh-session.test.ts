import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";
import { FRESH_SESSION_PATHS } from "./fresh-session.ts";
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

/**
 * Post an empty body to a gated endpoint with `cookie`.
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

    const body = yield* Effect.promise((): Promise<{ readonly code?: string }> =>
      response.json().catch(() => ({})),
    );

    return { code: body.code, status: response.status };
  });

layer(LocalAuthD1.layer)("fresh session on account-changing calls", (it) => {
  it.effect.each([...FRESH_SESSION_PATHS])(
    "%s refuses a stale session and allows a fresh one",
    (path) =>
      Effect.gen(function* gate() {
        const binding = yield* LocalAuthD1;

        return yield* Effect.gen(function* flow() {
          const email = `${path.replaceAll("/", "-").slice(1)}@example.test`;

          yield* signUp(email);

          // Without `session_data` Better Auth reads the session row, so its age is the stored one.
          const cookie = tokenOnly(cookieOf(yield* signIn(email)));

          const fresh = yield* post(path, cookie);

          assert.notStrictEqual(fresh.code, "SESSION_NOT_FRESH");
          assert.notStrictEqual(fresh.status, 401);

          yield* Effect.promise(() =>
            binding
              .prepare("UPDATE session SET created_at = ?")
              .bind(Date.now() - FRESH_AGE_MS - 1000)
              .run(),
          );

          const stale = yield* post(path, cookie);

          assert.strictEqual(stale.status, 403);
          assert.strictEqual(stale.code, "SESSION_NOT_FRESH");
        }).pipe(Effect.provide(authOver(binding)), asExecution);
      }),
  );
});
