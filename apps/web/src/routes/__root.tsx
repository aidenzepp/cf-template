import { createIsomorphicFn } from "@tanstack/react-start";
import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import {
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRoute,
  useRouteContext,
} from "@tanstack/react-router";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { StatusToaster } from "../components/status-toaster.tsx";
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
 * The layout of every page: the page and the one toaster. `data-session` carries the session state
 * for tests.
 *
 * @returns The layout.
 */
const RootLayout = () => {
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
 * The root context of a request.
 */
const readContext = Effect.gen(function* readRootContext() {
  const authMethods = yield* AuthMethods;
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
  beforeLoad: ({ abortController }) => run(readContext, { signal: abortController.signal }),
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
