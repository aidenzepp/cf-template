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
 * Send one JSON request to the instance's handler under {@link HTTPS_ORIGIN}.
 *
 * @param path - The path under the origin.
 * @param body - The JSON text of the body.
 * @returns The handler's response and the instance that answered it.
 */
const post = Effect.fn("post")(function* post(path: string, body: string) {
  const instance = yield* (yield* yield* AuthService).auth;

  const response = yield* Effect.promise(() =>
    instance.handler(
      new Request(`${HTTPS_ORIGIN}${path}`, {
        body,
        headers: { "content-type": "application/json", origin: HTTPS_ORIGIN },
        method: "POST",
      }),
    ),
  );

  return { instance, response };
});

layer(LocalAuthD1.layer)("the cookie contract under an https PUBLIC_ORIGIN", (it) => {
  it.effect("sets host-only, Secure, HttpOnly, SameSite=Lax, __Secure- cookies", () =>
    Effect.gen(function* contract() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const credentials = { email: "ada@example.test", password: "correct horse battery" };

        yield* post(
          "/auth/sign-up/email",
          JSON.stringify({ ...credentials, name: "Ada Lovelace" }),
        );

        const { instance, response } = yield* post(
          "/auth/sign-in/email",
          JSON.stringify(credentials),
        );

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

  it.effect("derives the OAuth callback as PUBLIC_ORIGIN, the base path and the provider", () =>
    Effect.gen(function* callback() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const { response } = yield* post(
          "/auth/sign-in/social",
          JSON.stringify({ callbackURL: "/", disableRedirect: true, provider: "github" }),
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
});
