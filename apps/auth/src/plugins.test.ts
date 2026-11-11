import { assert, it } from "@effect/vitest";
import type { BetterAuthPlugin } from "better-auth";
import { authOptions } from "./auth.ts";

/**
 * The plugin ids the instance may carry. `passkey` can create a user without a credential `account`
 * row; `rehash-after-sign-in` only rewrites a stored hash after a sign-in and creates no user.
 *
 * The orphan reclaim predicate (`apps/auth/src/reclaim.ts`) assumes that a user with no `account`
 * and no `passkey` is an abandoned password sign-up. A plugin that creates users without a
 * credential row, such as magic link, email OTP, anonymous or phone, breaks that assumption, so
 * adding a plugin outside this list fails the test below and forces a review of the predicate.
 */
const ALLOWED_PLUGIN_IDS: ReadonlySet<string> = new Set(["passkey", "rehash-after-sign-in"]);

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

it("flags a plugin that can create a user without a credential row", () => {
  assert.deepStrictEqual(outsideAllowlist([...authOptions.plugins, { id: "magic-link" }]), [
    "magic-link",
  ]);
});
