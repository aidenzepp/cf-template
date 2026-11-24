import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { Effect, Option, Schema } from "effect";
import type { ScryptCost } from "@workspace/config/auth-password";
import { hashEffect, needsRehash, verifyEffect } from "./password.ts";

/**
 * Runs an Effect with the services of the request that built the instance and settles with its
 * value, as `Effect.runPromiseWith(services)` does.
 */
export type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/**
 * The failure of one call to the Better Auth adapter while rehashing a password.
 */
class RehashAdapterError extends Schema.TaggedError<
  RehashAdapterError,
  { readonly brand: unique symbol }
>()("RehashAdapterError", {
  cause: Schema.Defect(),
}) {}

/**
 * The Better Auth `password.hash` and `password.verify` options over a runner.
 *
 * @param params - The knob's current value, the cost of every new hash.
 * @param run - Runs an effect with the captured services.
 * @returns The two Promise adapters.
 */
export const passwordFor = (params: ScryptCost, run: RunEffect) => ({
  hash: (password: string) => run(hashEffect(params, password)),
  verify: (input: { hash: string; password: string }) => run(verifyEffect(input)),
});

/**
 * The sign-in body the rehash reads: the plaintext password Better Auth has just verified.
 */
const SignInBody = Schema.Struct({ password: Schema.String });

/**
 * A Better Auth plugin whose `hooks.after` on `/sign-in/email` rewrites the signed-in user's
 * credential hash when its cost differs from `params`.
 *
 * Better Auth `1.7.19` runs plugin `hooks.after` entries whose `matcher` accepts the endpoint
 * context (`node_modules/better-auth/dist/api/dispatch.mjs`, `getHooks`), and `ctx.body` still
 * carries the plaintext password there. A failed rewrite logs `auth.password.rehash_failed` and
 * never fails the sign-in.
 *
 * @param params - The knob's current value.
 * @param run - Runs an effect with the captured services.
 * @returns The plugin.
 */
export const rehashAfterSignIn = (params: ScryptCost, run: RunEffect) =>
  ({
    hooks: {
      after: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            const body = Schema.decodeUnknownOption(SignInBody)(ctx.body);

            if (userId === undefined || Option.isNone(body)) {
              return;
            }

            await run(
              Effect.gen(function* rehash() {
                const account = yield* Effect.tryPromise({
                  catch: (cause) => new RehashAdapterError({ cause }),
                  try: () => ctx.context.internalAdapter.findCredentialAccount(userId),
                });

                const stored = account?.password;

                if (
                  account === null ||
                  account === undefined ||
                  stored === undefined ||
                  stored === null ||
                  !needsRehash(stored, params)
                ) {
                  return;
                }

                const replacement = yield* hashEffect(params, body.value.password);

                // Compare-and-set: only the row still holding the hash just verified is rewritten, so a
                // password changed meanwhile is never reverted.
                yield* Effect.tryPromise({
                  catch: (cause) => new RehashAdapterError({ cause }),
                  try: () =>
                    ctx.context.adapter.updateMany({
                      model: "account",
                      update: { password: replacement },
                      where: [
                        { field: "id", value: account.id },
                        { field: "password", value: stored },
                      ],
                    }),
                });
              }).pipe(Effect.catchCause(() => Effect.logWarning("auth.password.rehash_failed"))),
            );
          }),
          matcher: (ctx) => ctx.path === "/sign-in/email",
        },
      ],
    },
    id: "rehash-after-sign-in",
  }) satisfies BetterAuthPlugin;
