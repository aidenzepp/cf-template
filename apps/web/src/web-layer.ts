import { Config, ConfigProvider, Context, Effect, Layer } from "effect";
import { decodeAuthMethods } from "@workspace/config/auth-methods";
import type { AuthMethods as AuthMethodsValue } from "@workspace/config/auth-methods";
import { AUTH_ORPHAN_GRACE_SECONDS } from "@workspace/config/auth-orphan-grace";

/**
 * The seconds an abandoned sign-up stays unreclaimable, as `infra` bound
 * `AUTH_ORPHAN_GRACE_SECONDS`.
 */
export class OrphanGraceSeconds extends Context.Service<OrphanGraceSeconds, number>()(
  "@workspace/web/OrphanGraceSeconds",
) {}

/**
 * Build the layer that reads the orphan grace through the knob's own `Config`, each time the layer
 * is built, never at module load. An absent value is the knob's default; an invalid one fails.
 *
 * @param env - The bound text.
 * @param env.AUTH_ORPHAN_GRACE_SECONDS - The text `infra` binds.
 * @returns The layer that provides {@link OrphanGraceSeconds}.
 */
export const makeOrphanGraceLayer = (env: { readonly AUTH_ORPHAN_GRACE_SECONDS: string }) =>
  Layer.effect(OrphanGraceSeconds)(
    AUTH_ORPHAN_GRACE_SECONDS.config.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.map((seconds) => OrphanGraceSeconds.of(seconds)),
    ),
  );

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

/**
 * Read the stack name `infra` bound as `STACK_NAME` through `Config`. The stack name is the
 * project's identity, so the placeholder page shows it as the title. An absent or empty value
 * fails: there is no fallback name.
 *
 * @param env - The bound text.
 * @param env.STACK_NAME - The stack name `infra` binds.
 * @returns The stack name.
 */
export const readStackName = (env: { readonly STACK_NAME: string }) =>
  Config.NonEmptyString("STACK_NAME").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );
