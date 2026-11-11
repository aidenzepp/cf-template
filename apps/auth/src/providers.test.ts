import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { AuthService } from "./auth.ts";
import { socialProviders } from "./providers.ts";
import { LocalAuthD1, asExecution, authOver, handle } from "./test-harness.ts";

/**
 * Ask Better Auth to start a sign-in with `provider`, without following the redirect.
 *
 * @param provider - The provider id in the request body.
 * @returns The response.
 */
const startSignIn = (provider: string) =>
  handle("/auth/sign-in/social", {
    body: JSON.stringify({ callbackURL: "/", disableRedirect: true, provider }),
    method: "POST",
  });

describe("socialProviders", () => {
  it.effect("registers exactly the listed providers from the bound credentials", () =>
    Effect.gen(function* registers() {
      const registered = yield* socialProviders(
        { email: false, providers: ["github"] },
        {
          GITHUB_CLIENT_ID: "id",
          GITHUB_CLIENT_SECRET: "secret",
          GOOGLE_CLIENT_ID: "other-id",
          GOOGLE_CLIENT_SECRET: "other-secret",
          UNRELATED: "present",
        },
      );

      assert.deepStrictEqual(registered, { github: { clientId: "id", clientSecret: "secret" } });
    }),
  );

  it.effect("registers nothing when no provider is listed", () =>
    Effect.gen(function* registersNone() {
      const registered = yield* socialProviders({ email: false, providers: [] }, {});

      assert.deepStrictEqual(registered, {});
    }),
  );

  it.effect(
    "fails through the Config error channel when a listed provider has no credentials",
    () =>
      Effect.gen(function* fails() {
        const exit = yield* Effect.exit(
          socialProviders({ email: false, providers: ["google"] }, { GOOGLE_CLIENT_ID: "id" }),
        );

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});

layer(LocalAuthD1.layer)("the instance's providers", (live) => {
  live.effect("answers 404 PROVIDER_NOT_FOUND for a provider that is not listed", () =>
    Effect.gen(function* absent() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const response = yield* startSignIn("github");

        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          code: "PROVIDER_NOT_FOUND",
          message: "Provider not found",
        });
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );

  live.effect("starts a sign-in with a listed provider", () =>
    Effect.gen(function* listed() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const response = yield* startSignIn("github");

        assert.strictEqual(response.status, 200);
        assert.isTrue((yield* Effect.promise(() => response.text())).includes("github.com"));
      }).pipe(
        Effect.provide(
          authOver(binding, {
            AUTH_METHODS: '{"email":false,"providers":["github"]}',
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
          }),
        ),
        asExecution,
      );
    }),
  );

  live.effect("exposes the Better Auth instance whose options name the OAuth error route", () =>
    Effect.gen(function* options() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const instance = yield* (yield* yield* AuthService).auth;

        assert.strictEqual(instance.options.onAPIError?.errorURL, "/oauth-error");
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );
});
