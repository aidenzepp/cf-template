import { createIsomorphicFn } from "@tanstack/react-start";
import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import { createRootRoute } from "@tanstack/react-router";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Effect } from "effect";
import { RootDocument, RootLayout } from "../components/root-shell.tsx";
import { run } from "../runtime.ts";
import { readSession } from "../session.ts";
import { AuthMethods } from "../web-layer.ts";
import appCss from "../styles/app.css?url";

/**
 * The `Retry-After` seconds answered when `api` sent none or a value that is not whole seconds.
 */
const FALLBACK_RETRY_AFTER_SECONDS = 5;

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
