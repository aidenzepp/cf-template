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
