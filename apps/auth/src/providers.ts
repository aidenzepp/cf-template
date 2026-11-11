import type { WorkerEnvironment } from "@alchemy.run/cloudflare";
import { Config, ConfigProvider, Effect, Redacted } from "effect";
import type { AuthMethods, ProviderId } from "@workspace/config/auth-methods";

/**
 * The providers {@link socialProviders} registers, each present only when listed.
 */
interface Registered {
  github?: Credentials;
  google?: Credentials;
}

/**
 * The binding names of each provider's credential pair, the names `infra` binds.
 */
const PAIRS = {
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
} as const satisfies Record<
  typeof ProviderId.Type,
  { readonly id: string; readonly secret: string }
>;

/**
 * The plain credentials Better Auth registers a provider with.
 */
interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Read one provider's credential pair from the Worker's bindings. The values stay `Redacted` until
 * {@link socialProviders} hands them to Better Auth.
 *
 * @param provider - A provider id listed in `AUTH_METHODS`.
 * @returns The Better Auth options for the provider.
 */
const optionsOf = (provider: typeof ProviderId.Type) =>
  Config.all({
    clientId: Config.Redacted(PAIRS[provider].id),
    clientSecret: Config.Redacted(PAIRS[provider].secret),
  }).pipe(
    Config.map(({ clientId, clientSecret }) => ({
      clientId: Redacted.value(clientId),
      clientSecret: Redacted.value(clientSecret),
    })),
  );

/**
 * The Better Auth `socialProviders` option: exactly the providers `AUTH_METHODS` lists, each with
 * the credentials bound to the Worker. A provider that is not listed is not registered, so Better
 * Auth answers 404 `PROVIDER_NOT_FOUND` for it. A listed provider with a missing binding fails
 * through the `Config` error channel.
 *
 * @param methods - The bound `AUTH_METHODS`; this function never recomputes it.
 * @param env - The Worker's bindings.
 * @returns The registered providers keyed by id.
 */
export const socialProviders = Effect.fn("auth.socialProviders")(function* socialProviders(
  methods: typeof AuthMethods.Type,
  env: typeof WorkerEnvironment.Service,
) {
  const source = ConfigProvider.fromUnknown(env);
  const registered: Registered = {};

  if (methods.providers.includes("github")) {
    registered.github = yield* optionsOf("github").parse(source);
  }

  if (methods.providers.includes("google")) {
    registered.google = yield* optionsOf("google").parse(source);
  }

  return registered;
});
