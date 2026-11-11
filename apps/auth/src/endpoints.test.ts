import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { AuthService } from "./auth.ts";
import type { AuthInstance } from "./auth.ts";
import { CREDENTIAL_PATHS, ENDPOINT_CLASSES } from "./contract.ts";
import { LocalAuthD1, asExecution, authOver } from "./test-harness.ts";

/**
 * The parts of a Better Auth endpoint the router reads: its path, and the `SERVER_ONLY` flag that
 * keeps it off the router.
 */
const Endpoint = Schema.Struct({
  options: Schema.optional(
    Schema.Struct({
      metadata: Schema.optional(Schema.Struct({ SERVER_ONLY: Schema.optional(Schema.Boolean) })),
    }),
  ),
  path: Schema.String,
});

/**
 * The HTTP paths Better Auth registers for the configured instance, sorted.
 *
 * Better Auth's router adds every endpoint that has a path and is not `SERVER_ONLY`; this is the
 * same filter over the instance's endpoint map.
 *
 * @param api - The instance's endpoint map.
 * @returns The registered paths.
 */
const registeredPaths = (api: Effect.Success<AuthInstance["auth"]>["api"]): ReadonlyArray<string> =>
  Object.values(api)
    .flatMap((endpoint) => {
      const parsed = Schema.decodeUnknownOption(Endpoint)({
        options: endpoint.options,
        path: endpoint.path,
      });

      return Option.isSome(parsed) && parsed.value.options?.metadata?.SERVER_ONLY !== true
        ? [parsed.value.path]
        : [];
    })
    .toSorted();

/**
 * The paths the class table does not name.
 *
 * @param paths - Registered paths.
 * @returns The paths with no class.
 */
const unclassified = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => !Object.hasOwn(ENDPOINT_CLASSES, path));

/**
 * The endpoint paths Better Auth registers, snapshotted. A change here is reviewed, classified in
 * `ENDPOINT_CLASSES` and only then accepted.
 */
const SNAPSHOT = [
  "/account-info",
  "/callback/:id",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/passkey/delete-passkey",
  "/passkey/generate-authenticate-options",
  "/passkey/generate-register-options",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/sign-up/email",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

layer(LocalAuthD1.layer)("the registered endpoints", (live) => {
  live.effect("match the snapshot, and the class table names exactly that set", () =>
    Effect.gen(function* snapshot() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const instance = yield* (yield* yield* AuthService).auth;
        const paths = registeredPaths(instance.api);

        assert.deepStrictEqual(paths, SNAPSHOT);
        assert.deepStrictEqual(unclassified(paths), []);
        assert.deepStrictEqual(Object.keys(ENDPOINT_CLASSES).toSorted(), SNAPSHOT);
      }).pipe(Effect.provide(authOver(binding)), asExecution);
    }),
  );
});

describe("the class table", () => {
  it("fails on an endpoint it does not name", () => {
    assert.deepStrictEqual(unclassified([...SNAPSHOT, "/brand-new"]), ["/brand-new"]);
  });

  it("puts every endpoint that hashes or verifies a password in the credential class", () => {
    assert.deepStrictEqual(CREDENTIAL_PATHS.toSorted(), [
      "/change-password",
      "/delete-user",
      "/reset-password",
      "/sign-in/email",
      "/sign-up/email",
      "/verify-password",
    ]);
  });
});
