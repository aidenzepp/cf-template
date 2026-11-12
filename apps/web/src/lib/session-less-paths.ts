/**
 * The paths that never read the session: the outage page must not wait on the dependency that
 * failed.
 */
const SESSION_LESS_PATHS = ["/unavailable"] as const;

/**
 * Whether a path skips the session read. The match is exact: `/unavailable/` and `/unavailable2` do
 * not match.
 *
 * @param pathname - The pathname of the request, without search or hash.
 * @returns `true` when the root `beforeLoad` returns `unknown` without calling `api`.
 */
export const isSessionLess = (pathname: string): boolean =>
  SESSION_LESS_PATHS.some((path) => path === pathname);

/**
 * The auth screens a signed-out caller must reach. The guard does not redirect them, or `/sign-in`
 * would redirect to itself.
 */
const AUTH_SCREEN_PATHS = ["/sign-in", "/sign-up", "/oauth-error"] as const;

/**
 * Whether a path is an auth screen. The match is exact.
 *
 * @param pathname - The pathname of the request, without search or hash.
 * @returns `true` when a signed-out caller may load the path.
 */
export const isAuthScreen = (pathname: string): boolean =>
  AUTH_SCREEN_PATHS.some((path) => path === pathname);
