import { RegistryProvider } from "@effect/atom-react";
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
import { Toaster } from "@workspace/ui/components/ui/sonner";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
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
 * The root context of a request. A session-less path reads no session, so the outage page never
 * waits on `api`.
 *
 * @param pathname - The pathname of the request.
 * @returns The effect that reads the context.
 */
const readContext = (pathname: string) =>
  Effect.gen(function* readPathContext() {
    const authMethods = yield* AuthMethods;

    const session = isSessionLess(pathname) ? ({ _tag: "unknown" } as const) : yield* readSession;

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
