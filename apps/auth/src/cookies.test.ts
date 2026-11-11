import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";
import { AuthService } from "./auth.ts";
import { AUTH_BASE_PATH } from "./contract.ts";
import { LocalAuthD1, asExecution, authOver } from "./test-harness.ts";

/**
 * The `https://` public origin the instances under test are built for: the shape of every cloud
 * stage's `PUBLIC_ORIGIN`.
 */
const HTTPS_ORIGIN = "https://stack-web-test-cookies.acme.workers.dev";

/**
 * The local dev origin, the only `http://` value `publicOrigin` produces.
 */
const HTTP_ORIGIN = "http://localhost:3000";

/**
 * Where a request is addressed and which `Origin` header it carries.
 */
interface Via {
  readonly host: string;
  readonly origin: string;
}

/**
 * The request path of a sign-in with email and password.
 */
const SIGN_IN = "/auth/sign-in/email";

/**
 * Send one JSON request to the instance's handler.
 *
 * @param path - The path under the host.
 * @param body - The JSON text of the body.
 * @param via - The host the request is addressed to and its `Origin` header.
 * @returns The handler's response and the instance that answered it.
 */
const post = Effect.fn("post")(function* post(path: string, body: string, via: Via) {
  const instance = yield* (yield* yield* AuthService).auth;

  const response = yield* Effect.promise(() =>
    instance.handler(
      new Request(`${via.host}${path}`, {
        body,
        headers: { "content-type": "application/json", origin: via.origin },
        method: "POST",
      }),
    ),
  );

  return { instance, response };
});

/**
 * Sign up and sign in the same user through {@link post}.
 *
 * @param via - The host and `Origin` of the requests.
 * @returns The sign-in response.
 */
const signedIn = Effect.fn("signedIn")(function* signedIn(via: Via) {
  const credentials = { email: "ada@example.test", password: "correct horse battery" };

  yield* post("/auth/sign-up/email", JSON.stringify({ ...credentials, name: "Ada Lovelace" }), via);

  return yield* post(SIGN_IN, JSON.stringify(credentials), via);
});

layer(LocalAuthD1.layer)("the cookie contract under an https PUBLIC_ORIGIN", (it) => {
  it.effect("sets host-only, Secure, HttpOnly, SameSite=Lax, __Secure- cookies", () =>
    Effect.gen(function* contract() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const { instance, response } = yield* signedIn({
          host: HTTPS_ORIGIN,
          origin: HTTPS_ORIGIN,
        });

        const cookies = response.headers.getSetCookie();

        assert.strictEqual(response.status, 200);
        assert.isAbove(cookies.length, 0);

        for (const cookie of cookies) {
          assert.match(cookie, /^__Secure-/u);
          assert.match(cookie, /;\s*Secure/iu);
          assert.match(cookie, /;\s*HttpOnly/iu);
          assert.match(cookie, /;\s*SameSite=Lax/iu);
          assert.notMatch(cookie, /;\s*Domain=/iu);
        }

        // `baseURL` and `basePath` are the bound origin and the contract's path, untouched.
        assert.strictEqual(instance.options.baseURL, HTTPS_ORIGIN);
        assert.strictEqual(instance.options.basePath, AUTH_BASE_PATH);
      }).pipe(Effect.provide(authOver(binding, { PUBLIC_ORIGIN: HTTPS_ORIGIN })), asExecution);
    }),
  );

  // Better Auth skips its origin middleware under `NODE_ENV=test`, so a request-level 403 cannot be
  // observed here. These pin the list and the predicate that middleware validates every origin,
  // callbackURL, errorCallbackURL and redirect with.
  it.effect("trusts only PUBLIC_ORIGIN for origins and redirects", () =>
    Effect.gen(function* trust() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const instance = yield* (yield* yield* AuthService).auth;
        const context = yield* Effect.promise(() => instance.$context);

        assert.deepStrictEqual(context.trustedOrigins, [HTTPS_ORIGIN]);

        for (const url of [
          "https://evil.example/x",
          "//evil.example",
          "/\\evil.example",
          "https://other-web.acme.workers.dev",
          `${HTTPS_ORIGIN}.evil.example`,
        ]) {
          assert.isFalse(context.isTrustedOrigin(url, { allowRelativePaths: true }), url);
        }

        assert.isFalse(
          context.isTrustedOrigin("https://evil.example", { allowRelativePaths: false }),
        );
        assert.isTrue(context.isTrustedOrigin("/dashboard", { allowRelativePaths: true }));
        assert.isTrue(
          context.isTrustedOrigin(`${HTTPS_ORIGIN}/dashboard`, { allowRelativePaths: true }),
        );
      }).pipe(Effect.provide(authOver(binding, { PUBLIC_ORIGIN: HTTPS_ORIGIN })), asExecution);
    }),
  );

  it.effect("derives the OAuth callback from PUBLIC_ORIGIN, not from the request host", () =>
    Effect.gen(function* callback() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const { response } = yield* post(
          "/auth/sign-in/social",
          JSON.stringify({ callbackURL: "/", disableRedirect: true, provider: "github" }),
          { host: "https://attacker.test", origin: HTTPS_ORIGIN },
        );

        const { url } = yield* Effect.promise((): Promise<{ readonly url: string }> =>
          response.json(),
        );

        assert.strictEqual(
          new URL(url).searchParams.get("redirect_uri"),
          `${HTTPS_ORIGIN}${AUTH_BASE_PATH}/callback/github`,
        );
      }).pipe(
        Effect.provide(
          authOver(binding, {
            AUTH_METHODS: '{"email":false,"providers":["github"]}',
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            PUBLIC_ORIGIN: HTTPS_ORIGIN,
          }),
        ),
        asExecution,
      );
    }),
  );

  it.effect("sets host-only cookies without Secure or the prefix on the http dev origin", () =>
    Effect.gen(function* dev() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const { response } = yield* signedIn({ host: HTTP_ORIGIN, origin: HTTP_ORIGIN });
        const cookies = response.headers.getSetCookie();

        assert.strictEqual(response.status, 200);
        assert.isAbove(cookies.length, 0);

        for (const cookie of cookies) {
          assert.notMatch(cookie, /^__Secure-/u);
          assert.notMatch(cookie, /;\s*Secure/iu);
          assert.notMatch(cookie, /;\s*Domain=/iu);
        }
      }).pipe(Effect.provide(authOver(binding, { PUBLIC_ORIGIN: HTTP_ORIGIN })), asExecution);
    }),
  );
});
