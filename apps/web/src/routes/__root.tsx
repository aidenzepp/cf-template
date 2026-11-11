import { RegistryProvider } from "@effect/atom-react";
import { createIsomorphicFn } from "@tanstack/react-start";
import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import {
  ErrorComponent,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRoute,
  redirect,
  useRouteContext,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Toaster } from "@workspace/ui/components/ui/sonner";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { isAuthUnavailable, Retry } from "../components/retry.tsx";
import { Nav } from "../components/shell/nav.tsx";
import { UserMenu } from "../components/shell/user-menu.tsx";
import { validateRedirectSearch } from "../lib/redirect-target.ts";
import { isAuthScreen, isSessionLess } from "../lib/session-less-paths.ts";
import { run } from "../runtime.ts";
import { readSession } from "../session.ts";
import { AuthMethods } from "../web-layer.ts";
import appCss from "../styles/app.css?url";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The `Retry-After` seconds answered when `api` sent none or a value that is not whole seconds.
 */
const FALLBACK_RETRY_AFTER_SECONDS = 5;

/**
 * Sets the `dark` class of the document from `prefers-color-scheme` before the first paint.
 */
const THEME_SCRIPT = `document.documentElement.classList.toggle("dark", matchMedia("${DARK_QUERY}").matches)`;

const subscribeTheme = (onChange: () => void) => {
  const query = matchMedia(DARK_QUERY);

  const onPreference = () => {
    document.documentElement.classList.toggle("dark", query.matches);
    onChange();
  };

  query.addEventListener("change", onPreference);

  return () => {
    query.removeEventListener("change", onPreference);
  };
};

/**
 * The theme the browser prefers, `light` on the server and until hydration. It also keeps the
 * document's `dark` class in step when the preference changes.
 *
 * @returns The resolved theme.
 */
const useResolvedTheme = (): "light" | "dark" =>
  useSyncExternalStore(
    subscribeTheme,
    () => (matchMedia(DARK_QUERY).matches ? "dark" : "light"),
    () => "light",
  );

/**
 * The document shell of every page.
 *
 * @param props - The shell's props.
 * @param props.children - The matched route's page.
 * @returns The `html` element of the page.
 */
const RootDocument = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      <HeadContent />
    </head>
    <body>
      <ScriptOnce>{THEME_SCRIPT}</ScriptOnce>
      {children}
      <Scripts />
    </body>
  </html>
);

/**
 * The layout of every page: the header with the nav and the user menu, the page, and the one
 * toaster.
 *
 * @returns The layout.
 */
const RootLayout = () => {
  const { session } = useRouteContext({ from: "__root__" });
  const resolvedTheme = useResolvedTheme();

  return (
    <RegistryProvider>
      <header
        className="flex items-center justify-between gap-4 border-b p-4"
        data-session={session._tag}
      >
        {session._tag === "signedOut" ? <span /> : <Nav />}
        <UserMenu />
      </header>
      <Outlet />
      <Toaster theme={resolvedTheme} />
    </RegistryProvider>
  );
};

/**
 * The `Retry-After` seconds of a failed session read, from the header `api` answered with.
 *
 * @param header - The `Retry-After` header text, when `api` sent one.
 * @returns The whole seconds, or {@link FALLBACK_RETRY_AFTER_SECONDS} when the header is absent or
 *   not a whole number.
 */
const parseRetryAfter = (header: string | undefined): number => {
  const seconds = Number(header);

  return Number.isInteger(seconds) && seconds >= 0 ? seconds : FALLBACK_RETRY_AFTER_SECONDS;
};

/**
 * Answers the server-rendered response of an unreadable session with `503` and `Retry-After`. The
 * browser has no response to set, so it only passes the seconds through.
 */
const answerUnavailable = createIsomorphicFn()
  .server((retryAfterSeconds: number) => {
    setResponseStatus(503);
    setResponseHeader("Retry-After", String(retryAfterSeconds));

    return retryAfterSeconds;
  })
  .client((retryAfterSeconds: number) => retryAfterSeconds);

/**
 * The root context of a request. A session-less path reads no session, so the outage page never
 * waits on `api`.
 *
 * @param pathname - The pathname of the request.
 * @returns The effect that reads the context.
 */
const readContext = (pathname: string) =>
  Effect.gen(function* readPathContext() {
    const authMethods = yield* AuthMethods;

    if (isSessionLess(pathname)) {
      return { authMethods, session: { _tag: "unknown" } as const } as const;
    }

    const session = yield* readSession;

    if (session._tag === "unknown") {
      const retryAfterSeconds = answerUnavailable(
        parseRetryAfter("retryAfter" in session ? session.retryAfter : undefined),
      );

      return yield* new AuthUnavailable({ retryAfterSeconds });
    }

    return { authMethods, session } as const;
  });

export const Route = createRootRoute({
  // Only `signedOut` redirects. The `redirect` value is kept only when it is root-relative; the
  // hash is empty on the server, which never receives it.
  beforeLoad: async ({ abortController, location }) => {
    const context = await run(readContext(location.pathname), { signal: abortController.signal });

    if (context.session._tag === "signedOut" && !isAuthScreen(location.pathname)) {
      const { redirect: target } = validateRedirectSearch({
        redirect: `${location.pathname}${location.searchStr}${location.hash}`,
      });

      // `throw: true` makes the library throw the redirect, which keeps it out of the context type
      // that a returned `Redirect` would break for every child route.
      redirect<AnyRouter>({
        search: target === undefined ? {} : { redirect: target },
        throw: true,
        to: "/sign-in",
      });
    }

    return context;
  },
  component: RootLayout,
  errorComponent: ({ error }) =>
    error instanceof Error && isAuthUnavailable(error) ? (
      <Retry />
    ) : (
      <ErrorComponent error={error} />
    ),
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "web" },
    ],
  }),
  headers: () => ({ "Cache-Control": "private, no-store" }),
  shellComponent: RootDocument,
});
