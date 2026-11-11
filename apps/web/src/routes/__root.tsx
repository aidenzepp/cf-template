import { RegistryProvider } from "@effect/atom-react";
import {
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRoute,
  useRouteContext,
} from "@tanstack/react-router";
import { Toaster } from "@workspace/ui/components/ui/sonner";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Nav } from "../components/shell/nav.tsx";
import { UserMenu } from "../components/shell/user-menu.tsx";
import { run } from "../runtime.ts";
import { readRootContext } from "../session.ts";
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

export const Route = createRootRoute({
  beforeLoad: ({ abortController }) => run(readRootContext, { signal: abortController.signal }),
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
