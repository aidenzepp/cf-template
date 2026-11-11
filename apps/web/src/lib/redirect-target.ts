import { Option, Schema } from "effect";

/**
 * A root-relative path: it starts with exactly one `/`, so `//host`, `/\host` and `https://` fail.
 */
const RedirectTarget = Schema.String.check(Schema.isPattern(/^\/(?![/\\])/u));

const decodeTarget = Schema.decodeUnknownOption(RedirectTarget);

/**
 * Where an auth screen sends a person when no valid `redirect` was supplied.
 */
export const DEFAULT_REDIRECT = "/";

/**
 * Validate the `redirect` search param of the auth screens. A missing or invalid value is left out,
 * so a bare `/sign-in` keeps its URL; callers read {@link DEFAULT_REDIRECT} in its place.
 *
 * @param search - The raw search object of the route.
 * @returns The search with `redirect` set only when it is a root-relative path.
 */
export const validateRedirectSearch = (search: { readonly redirect?: unknown }) => ({
  redirect: Option.getOrUndefined(decodeTarget(search.redirect)),
});
