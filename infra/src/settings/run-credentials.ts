import { Config, Effect, Option, Schema } from "effect";

/**
 * The refusal of {@link refuseAmbientCredentials}: an environment variable could make the
 * `@alchemy.run/github` provider authenticate as, or talk to, something the admin guard never
 * checked.
 */
export class AmbientCredentialsError extends Schema.TaggedError<
  AmbientCredentialsError,
  { readonly brand: unique symbol }
>()("AmbientCredentialsError", { message: Schema.String }) {}

/**
 * The one token of a settings run: the admin guard, the REST calls and the provider all use it.
 */
export const githubToken = Config.Redacted("GITHUB_TOKEN");

/**
 * The variables the GitHub provider reads on its own: a second token that wins over `GITHUB_TOKEN`
 * and three that move it to an enterprise host.
 */
const AMBIENT_VARIABLES = [
  "GITHUB_ACCESS_TOKEN",
  "GH_HOST",
  "GITHUB_BASE_URL",
  "GITHUB_API_URL",
] as const;

/**
 * The public API endpoint. GitHub Actions sets `GITHUB_API_URL` to it on every runner, so
 * `GITHUB_API_URL` is refused only when it names something else.
 */
const PUBLIC_API_URL = "https://api.github.com";

/**
 * Whether a set variable is the public default that Actions runners provide: only
 * `GITHUB_API_URL`, only {@link PUBLIC_API_URL}, ignoring one trailing slash.
 *
 * @param name - The variable name.
 * @param value - The value it is set to.
 * @returns True when the value moves nothing off github.com.
 */
const isPublicDefault = (name: string, value: string) =>
  name === "GITHUB_API_URL" && value.replace(/\/$/u, "") === PUBLIC_API_URL;

/**
 * Refuse to start when any provider-side credential or host variable is set, except the public
 * default `GITHUB_API_URL`. Runs before any network call; the message names the variable and never
 * its value.
 *
 * @returns Nothing, or an {@link AmbientCredentialsError} naming the first variable set.
 */
export const refuseAmbientCredentials = Effect.fn("refuseAmbientCredentials")(
  function* refuseAmbientCredentials() {
    yield* Effect.forEach(
      AMBIENT_VARIABLES,
      Effect.fn(function* checkVariable(name) {
        const value = yield* Config.String(name).pipe(Config.option);

        return yield* Option.isSome(value) && !isPublicDefault(name, value.value)
          ? new AmbientCredentialsError({
              message: `${name} is set. The settings run uses only GITHUB_TOKEN on github.com; unset ${name} and run again.`,
            })
          : Effect.void;
      }),
      { discard: true },
    );
  },
);
