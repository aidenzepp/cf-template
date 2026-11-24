import { HeadContent, Outlet, ScriptOnce, Scripts, useRouteContext } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { StatusToaster } from "./status-toaster.tsx";

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
export const RootDocument = ({ children }: { readonly children: ReactNode }) => (
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
 * The layout of every page: the page and the one toaster. `data-session` carries the session state
 * for tests.
 *
 * @returns The layout.
 */
export const RootLayout = () => {
  const { session } = useRouteContext({ from: "__root__" });
  const resolvedTheme = useResolvedTheme();

  return (
    <>
      <div className="contents" data-session={session._tag}>
        <Outlet />
      </div>
      <StatusToaster theme={resolvedTheme} />
    </>
  );
};
