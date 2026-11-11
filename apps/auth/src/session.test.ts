import { assert, layer } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, Exit, Layer } from "effect";
import { Session } from "@workspace/contract/domain/session";
import { AuthService } from "./auth.ts";
import { CookieCacheMaxAgeKnob } from "./config.ts";
import { CheckSession } from "./session.ts";
import {
  LocalAuthD1,
  asExecution,
  authOver,
  cookieOf,
  disposedD1,
  signIn,
  signUp,
  tokenOnly,
} from "./test-harness.ts";

layer(LocalAuthD1.layer)("checkSession", (it) => {
  it.effect("returns the Session for the sign-in cookie", () =>
    Effect.gen(function* signedIn() {
      const binding = yield* LocalAuthD1;

      return yield* Effect.gen(function* check() {
        yield* signUp("ada@example.test");

        const cookie = cookieOf(yield* signIn("ada@example.test"));
        const checkSession = yield* CheckSession;
        const session = yield* checkSession({ cookie });

        assert.instanceOf(session, Session);
        assert.strictEqual(session?.email, "ada@example.test");
        assert.strictEqual(session?.name, "Ada Lovelace");
        assert.strictEqual(session?.image, null);
        assert.isTrue(
          DateTime.isGreaterThan(session?.expiresAt ?? DateTime.nowUnsafe(), DateTime.nowUnsafe()),
        );
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );

  it.effect("returns null for a request with no session cookie", () =>
    Effect.gen(function* signedOut() {
      const binding = yield* LocalAuthD1;

      return yield* Effect.gen(function* check() {
        const checkSession = yield* CheckSession;

        assert.isNull(yield* checkSession({ cookie: "" }));
        assert.isNull(yield* checkSession({ cookie: "unrelated=1" }));
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );

  it.effect("fails with AuthUnavailable, never null, when the store faults", () =>
    Effect.gen(function* faulted() {
      const binding = yield* LocalAuthD1;

      const cookie = yield* Effect.gen(function* signInFirst() {
        yield* signUp("grace@example.test");

        return cookieOf(yield* signIn("grace@example.test"));
      }).pipe(Effect.provide(authOver(binding)), asExecution);

      // Without `session_data` the check cannot answer from the cookie cache and must read D1.
      const withoutCache = tokenOnly(cookie);

      const broken = yield* disposedD1;

      const exit = yield* Effect.gen(function* check() {
        const checkSession = yield* CheckSession;

        return yield* Effect.exit(checkSession({ cookie: withoutCache }));
      }).pipe(Effect.provide(authOver(broken)), asExecution);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(Exit.isFailure(exit) && exit.cause.toString().includes("AuthUnavailable"));
    }),
  );

  it.effect("sends no refreshed Set-Cookie after a sign-in", () =>
    Effect.gen(function* noRefresh() {
      const binding = yield* LocalAuthD1;

      return yield* Effect.gen(function* check() {
        yield* signUp("hedy@example.test");

        const cookie = cookieOf(yield* signIn("hedy@example.test"));

        const instance = yield* (yield* yield* AuthService).auth;

        const { headers, response } = yield* Effect.promise(() =>
          instance.api.getSession({
            headers: new Headers({ cookie }),
            query: { disableRefresh: true },
            returnHeaders: true,
          }),
        );

        assert.isNotNull(response);
        assert.deepStrictEqual(headers.getSetCookie(), []);
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );
});

/**
 * Read `AUTH_COOKIE_CACHE_MAX_AGE_S` from a provider that holds `value`, without touching the host
 * environment.
 *
 * @param value - The raw setting.
 * @returns The exit of the knob's `Config`.
 */
const readMaxAge = (value: string) =>
  Effect.exit(
    CookieCacheMaxAgeKnob.config.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_COOKIE_CACHE_MAX_AGE_S: value })),
      ),
    ),
  );

layer(Layer.empty)("AUTH_COOKIE_CACHE_MAX_AGE_S", (it) => {
  it.effect("fails decode above the 900 s ceiling through the Config error channel", () =>
    Effect.gen(function* ceiling() {
      assert.isTrue(Exit.isFailure(yield* readMaxAge("901")));
      assert.isTrue(Exit.isFailure(yield* readMaxAge("0")));
      assert.isTrue(Exit.isSuccess(yield* readMaxAge("900")));
    }),
  );
});
