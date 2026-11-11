import { Schema } from "effect";

/**
 * The port the `web` dev server listens on under the `local` stage kind.
 */
export const WEB_DEV_PORT = 3000;

/**
 * The public origin of a stage: an `http://` or `https://` origin with no path, query or
 * fragment. Better Auth's `baseURL` and the trusted origin are this value.
 */
export const PublicOrigin = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/?#\s]+$/u, {
    description: "an http:// or https:// origin with no path",
  }),
).pipe(Schema.brand("PublicOrigin"));

/**
 * A DNS hostname by RFC 1123: dot-separated labels of 1 to 63 characters, each of `[a-z0-9]` with
 * inner `-`, and at most 253 characters in total. Effect 4.1.2 has no hostname schema.
 */
export const Hostname = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u,
    {
      description: "a lower case RFC 1123 hostname",
    },
  ),
);

/**
 * The value of `CUSTOM_DOMAIN`: a hostname, or `workers-dev` to run `prod` on `workers.dev`.
 */
export const CustomDomain = Schema.Union([Hostname, Schema.Literal("workers-dev")]);
