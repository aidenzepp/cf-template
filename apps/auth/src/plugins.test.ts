import { assert, it } from "@effect/vitest";
import type { BetterAuthPlugin } from "better-auth";
import { Option, Redacted } from "effect";
import { authOptions, oauthProxyPlugins } from "./auth.ts";

/**
 * The plugin ids the instance may carry. `passkey` can create a user without a credential `account`
 * row; `rehash-after-sign-in` only rewrites a stored hash after a sign-in and creates no user.
 *
 * The orphan reclaim predicate (`apps/auth/src/reclaim.ts`) assumes that a user with no `account`
 * and no `passkey` is an abandoned password sign-up. A plugin that creates users without a
 * credential row, such as magic link, email OTP, anonymous or phone, breaks that assumption, so
 * adding a plugin outside this list fails the test below and forces a review of the predicate.
 *
 * `oauth-proxy` was reviewed against better-auth 1.7.19: its completion endpoint
 * (`/callback/:id/oauth-proxy`) hands the decrypted profile to `handleOAuthUserInfo`, which creates
 * a new user through `createOAuthUser` (the user and its `account` row together) or links an
 * `account` row to an existing one; the link path needs a session and creates no user. Every user
 * it creates therefore has an `account` row, as the predicate expects.
 */
const ALLOWED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "oauth-proxy",
  "passkey",
  "rehash-after-sign-in",
]);

/**
 * The plugins of an instance whose stage binds the proxy settings.
 */
const proxied = oauthProxyPlugins(
  Option.some({ productionURL: "https://app.example.test", secret: Redacted.make("proxy") }),
);

/**
 * The ids of the plugins that are not in {@link ALLOWED_PLUGIN_IDS}.
 *
 * @param plugins - The plugins of a Better Auth instance.
 * @returns The ids outside the allowlist, in order.
 */
const outsideAllowlist = (plugins: ReadonlyArray<Pick<BetterAuthPlugin, "id">>) =>
  plugins.flatMap(({ id }) => (ALLOWED_PLUGIN_IDS.has(id) ? [] : [id]));

it("carries only plugins the orphan reclaim predicate was reviewed against", () => {
  assert.deepStrictEqual(outsideAllowlist(authOptions.plugins), []);
});

it("carries the oAuthProxy plugin only when the stage binds its settings", () => {
  assert.deepStrictEqual(
    proxied.map(({ id }) => id),
    ["oauth-proxy"],
  );
  assert.deepStrictEqual(outsideAllowlist(proxied), []);
  assert.deepStrictEqual(oauthProxyPlugins(Option.none()), []);
});

it("flags a plugin that can create a user without a credential row", () => {
  assert.deepStrictEqual(outsideAllowlist([...authOptions.plugins, { id: "magic-link" }]), [
    "magic-link",
  ]);
});
