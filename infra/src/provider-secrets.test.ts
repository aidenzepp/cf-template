import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, ConfigProvider, Effect, FileSystem, Order, Path, Redacted } from "effect";
import { encodedAuthMethods, resolveMethods } from "./auth.ts";

/**
 * The fake credentials of both providers, beside one unrelated variable.
 */
const CREDENTIALS = ConfigProvider.fromUnknown({
  GITHUB_CLIENT_ID: "fake-github-id",
  GITHUB_CLIENT_SECRET: "fake-github-secret",
  GOOGLE_CLIENT_ID: "fake-google-id",
  GOOGLE_CLIENT_SECRET: "fake-google-secret",
  UNRELATED: "present",
});

/**
 * Matches a provider credential name anywhere in a text.
 */
const CREDENTIAL_NAME = /(?:GITHUB|GOOGLE)_CLIENT_(?:ID|SECRET)/u;

describe("AUTH_METHODS as bound to web", () => {
  it.effect("holds provider ids only, no secret value and no secret key name", () =>
    Effect.gen(function* bound() {
      const text = yield* encodedAuthMethods.pipe(
        Effect.provide(ConfigProvider.layer(CREDENTIALS)),
      );

      assert.strictEqual(text, '{"email":false,"providers":["github","google"]}');

      for (const leaked of ["fake-github", "fake-google", "SECRET", "CLIENT"]) {
        assert.isFalse(text.includes(leaked), `AUTH_METHODS text leaks ${leaked}`);
      }
    }),
  );
});

describe("the provider credential bindings", () => {
  it.effect("stay Redacted until the auth Worker receives them", () =>
    Effect.gen(function* redacted() {
      const { secrets } = yield* resolveMethods().pipe(
        Effect.provide(ConfigProvider.layer(CREDENTIALS)),
      );

      assert.deepStrictEqual(Arr.sort(Object.keys(secrets), Order.String), [
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
      ]);

      for (const value of Object.values(secrets)) {
        assert.isTrue(Redacted.isRedacted(value));
      }
    }),
  );

  it.effect("are named in no env that infra builds for web or api", () =>
    Effect.gen(function* sources() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const file of ["web.ts", "api.ts"]) {
        const text = yield* fs.readFileString(
          yield* path.fromFileUrl(new URL(file, import.meta.url)),
        );

        assert.isFalse(CREDENTIAL_NAME.test(text), `${file} names a provider credential`);
        assert.isFalse(text.includes("resolveMethods"), `${file} reads the credential bindings`);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
