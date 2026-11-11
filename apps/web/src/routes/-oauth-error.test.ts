import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { OAUTH_ERROR_PATH } from "@workspace/contract/domain/auth-paths";
import { Effect, FileSystem, Layer, Path } from "effect";
import { OAUTH_ERROR_CODES, oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";

/**
 * `OAUTH_CALLBACK_ERROR_CODES` of `better-auth` 1.7.19, `dist/oauth2/errors.mjs`. The package
 * exports it from no entry point, so the values are pinned here; a version bump reviews them.
 */
const BETTER_AUTH_CALLBACK_CODES = [
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "invalid_code",
  "nonce_binding_missing",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
];

describe("/oauth-error copy", () => {
  it("shows the account-linking line for account_not_linked", () => {
    expect(oauthErrorCopy(oauthErrorCode("account_not_linked"))).toBe(
      "An account with this email already exists. Sign in with your password, then link GitHub in Settings.",
    );
  });

  it("shows the generic line for an unknown code", () => {
    expect(oauthErrorCopy(oauthErrorCode("nonsense"))).toBe("Sign-in didn't finish. Try again.");
  });

  it("has copy for every code Better Auth redirects with", () => {
    for (const code of BETTER_AUTH_CALLBACK_CODES) {
      expect(OAUTH_ERROR_CODES).toContain(code);
    }
  });

  it.effect("is in the generated route tree at OAUTH_ERROR_PATH", () =>
    Effect.gen(function* tree() {
      const fs = yield* FileSystem.FileSystem;

      const path = yield* Path.Path;

      const source = yield* fs.readFileString(
        yield* path.fromFileUrl(new URL("../route-tree.gen.ts", import.meta.url)),
      );

      expect(source).toContain(`path: '${OAUTH_ERROR_PATH}'`);
    }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer))),
  );
});
