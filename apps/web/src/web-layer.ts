import { Context, Effect, Layer } from "effect";
import { decodeAuthMethods } from "@workspace/config/auth-methods";
import type { AuthMethods as AuthMethodsValue } from "@workspace/config/auth-methods";

/**
 * The sign-in methods `infra` bound as `AUTH_METHODS`, decoded once when the runtime is built.
 */
export class AuthMethods extends Context.Service<AuthMethods, typeof AuthMethodsValue.Type>()(
  "@workspace/web/AuthMethods",
) {}

/**
 * Build the layers of `web` from the Worker's bindings.
 *
 * `AUTH_METHODS` is decoded here and nowhere else. A value that is missing, not JSON or the wrong
 * shape fails the layer, so no request is served on a guess: there is no fallback value.
 *
 * @param env - The Worker's bindings; only `AUTH_METHODS` is read.
 * @param env.AUTH_METHODS - The JSON text `infra` binds.
 * @returns The layer that provides {@link AuthMethods}.
 */
export const makeWebLayer = (env: { readonly AUTH_METHODS: string }) =>
  Layer.effect(AuthMethods)(
    decodeAuthMethods(env.AUTH_METHODS).pipe(Effect.map((methods) => AuthMethods.of(methods))),
  );
