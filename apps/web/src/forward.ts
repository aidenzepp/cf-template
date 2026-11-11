import { Cause, Effect } from "effect";
import type { ServiceBinding } from "./env.ts";
import { FORWARD_PREFIXES } from "./forward-prefixes.ts";

/**
 * The service binding a forwarded path belongs to.
 */
export type ForwardTarget = "API" | "AUTH";

/**
 * The headers dropped from every forwarded request: the trace-context headers (`web` injects none
 * of its own) and the client-address headers a caller can spoof. `cf-connecting-ip`, which the
 * edge sets, is the only client address left.
 */
const STRIPPED_HEADERS = [
  "traceparent",
  "tracestate",
  "b3",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
] as const;

/**
 * The binding that owns each prefix of {@link FORWARD_PREFIXES}.
 */
const TARGETS: Readonly<Record<(typeof FORWARD_PREFIXES)[number], ForwardTarget>> = {
  "/api/*": "API",
  "/auth/*": "AUTH",
};

/**
 * The binding that owns a path, taken from {@link FORWARD_PREFIXES}.
 *
 * @param pathname - The path of the request, without its query.
 * @returns The binding name, or `undefined` for a path TanStack handles.
 */
export const forwardTarget = (pathname: string): ForwardTarget | undefined => {
  const prefix = FORWARD_PREFIXES.find((pattern) => pathname.startsWith(pattern.slice(0, -1)));

  return prefix === undefined ? undefined : TARGETS[prefix];
};

/**
 * Whether the caller is a browser navigation that wants the HTML error page.
 *
 * @param headers - The headers of the failed request.
 * @returns `true` for `Sec-Fetch-Mode: navigate` or an `Accept` that names `text/html`.
 */
const wantsHtml = (headers: Headers): boolean =>
  headers.get("sec-fetch-mode") === "navigate" ||
  (headers.get("accept") ?? "").includes("text/html");

/**
 * The 502 `web` itself answers when a forward fails: one negotiation rule, a minimal HTML body for
 * a navigation and `application/problem+json` for anything else. Both vary on the two request
 * headers the rule reads.
 *
 * @param request - The request whose forward failed.
 * @returns The 502 response.
 */
export const badGateway = (request: Request): Response => {
  const vary = { vary: "Sec-Fetch-Mode, Accept" };

  return wantsHtml(request.headers)
    ? new Response("<h1>Bad Gateway</h1><p>The service did not answer. Try again shortly.</p>", {
        headers: { ...vary, "content-type": "text/html; charset=utf-8" },
        status: 502,
      })
    : Response.json(
        { status: 502, title: "Bad Gateway", type: "about:blank" },
        { headers: { ...vary, "content-type": "application/problem+json" }, status: 502 },
      );
};

/**
 * The 502 of a failed forward. A navigation gets the outage page `render` produces, with the status
 * and `Vary` of {@link badGateway}; anything else, and a navigation whose render fails or does not
 * answer 200, gets {@link badGateway}. The render is never retried.
 *
 * @param request - The request whose forward failed.
 * @param render - The render of the outage page, an effect of its HTML response.
 * @returns The 502 response.
 */
const failedForward = (request: Request, render: Effect.Effect<Response>) =>
  wantsHtml(request.headers)
    ? render.pipe(
        Effect.map((page) =>
          page.ok
            ? new Response(page.body, {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  vary: "Sec-Fetch-Mode, Accept",
                },
                status: 502,
              })
            : badGateway(request),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(badGateway(request)),
        ),
      )
    : Effect.succeed(badGateway(request));

/**
 * Forward a request to a service binding with its path, cookies and other headers intact.
 *
 * Inbound `traceparent`, `tracestate`, `b3`, `x-forwarded-for`, `x-real-ip` and `forwarded` are
 * removed and nothing is injected. Any status the
 * binding returns, 4xx and 5xx included, passes through unchanged. The forward fails only when the
 * binding rejects or throws, and that failure answers 502: the outage page for a navigation, the
 * problem document for anything else. The response is the binding's own object, so `Set-Cookie`
 * lines and redirects reach the client unchanged.
 *
 * @param binding - The service binding to call.
 * @param request - The inbound request.
 * @param render - The render of the outage page for the HTML branch of a failed forward.
 * @returns The binding's response, or the 502 of a failed forward.
 */
export const forward = Effect.fn("web.forward")(
  function* forward(binding: ServiceBinding, request: Request, _render: Effect.Effect<Response>) {
    const headers = new Headers(request.headers);

    for (const name of STRIPPED_HEADERS) {
      headers.delete(name);
    }

    // The binding's Response is returned as it is: its status, every Set-Cookie line and its body
    // stream are never parsed or rebuilt. A redirect is the backend's answer, so it is not followed.
    return yield* Effect.promise(() =>
      binding.fetch(new Request(request, { headers, redirect: "manual" })),
    );
  },
  (effect, _binding, request, render) =>
    Effect.catchCause(effect, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : failedForward(request, render),
    ),
);
