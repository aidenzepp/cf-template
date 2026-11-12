import { RegistryProvider, useAtomSubscribe } from "@effect/atom-react";
import { createIsomorphicFn } from "@tanstack/react-start";
import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import {
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
import { Effect } from "effect";
import type { ReactNode } from "react";
import { RouteError } from "../components/errors/error.tsx";
import { NotFound } from "../components/errors/not-found.tsx";
import { isAuthUnavailable, Retry } from "../components/retry.tsx";
import { AppShell } from "../components/shell/app-shell.tsx";
import { StatusToaster } from "../components/status-toaster.tsx";
import { resolvedThemeAtom, THEME_SCRIPT } from "../lib/appearance.ts";
import { validateRedirectSearch } from "../lib/redirect-target.ts";
import { isAuthScreen, isSessionLess } from "../lib/session-less-paths.ts";
import { run } from "../runtime.ts";
import { readSession } from "../session.ts";
import { AuthMethods } from "../web-layer.ts";
import appCss from "../styles/app.css?url";

/**
 * The `Retry-After` seconds answered when `api` sent none or a value that is not whole seconds.
 */
const FALLBACK_RETRY_AFTER_SECONDS = 5;

/**
 * Sets the `dark` class of the document to the resolved theme. The pre-paint script sets it for the
 * first paint; this keeps it in step when the appearance or the browser's preference changes.
 *
 * @param theme - The resolved theme.
 */
const applyTheme = (theme: "light" | "dark"): void => {
  document.documentElement.classList.toggle("dark", theme === "dark");
};

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
 * Keeps the document's `dark` class in step with the resolved theme. Inside the registry, it
 * renders nothing.
 *
 * @returns Nothing.
 */
const ThemeSync = () => {
  useAtomSubscribe(resolvedThemeAtom, applyTheme);

  return null;
};

/**
 * The layout of every page: the page inside the sidebar shell for a signed-in caller, the bare page
 * for any other state, and the one toaster. `data-session` carries the state for tests.
 *
 * @returns The layout.
 */
const RootLayout = () => {
  const { session } = useRouteContext({ from: "__root__" });

  return (
    <RegistryProvider>
      <ThemeSync />
      <div className="contents" data-session={session._tag}>
        {session._tag === "signedIn" ? (
          <AppShell>
            <Outlet />
          </AppShell>
        ) : (
          <Outlet />
        )}
      </div>
      <StatusToaster />
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
    error instanceof Error && isAuthUnavailable(error) ? <Retry /> : <RouteError />,
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "web" },
    ],
  }),
  headers: () => ({ "Cache-Control": "private, no-store" }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
});
