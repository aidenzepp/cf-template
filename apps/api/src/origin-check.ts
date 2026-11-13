import { Effect, Result } from "effect";
import { HttpRouter, HttpServerRequest, ProblemDetails, Url } from "effect/http";

/**
 * The `type` of the problem a request from a foreign origin gets.
 */
export const FOREIGN_ORIGIN_TYPE = "/problems/foreign-origin";

/**
 * Whether a request may reach the router: it carries no `Origin` header, or its `Origin` is the
 * origin it was addressed to. App and Api share one origin (`web` forwards `/api/*` with the
 * request's own URL), so the address of the request is the app's origin. A request whose URL has no
 * origin to compare against is refused when it names one.
 *
 * @param request - The request about to be routed.
 * @returns `true` when the request is same-origin or names no origin.
 */
export const isSameOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const { origin } = request.headers;

  if (origin === undefined) {
    return true;
  }

  return Result.match(Url.fromString(request.originalUrl), {
    onFailure: () => false,
    onSuccess: (url) => url.origin === origin,
  });
};

/**
 * The Origin check of the `api` Worker: a global router middleware that answers 403
 * `application/problem+json` to a request whose `Origin` header is not the app's origin, before
 * routing, so a command, a read and a live-read upgrade are refused alike. Commands and live reads
 * authenticate with the cookies the request carries, and Domain has no origin check of its own.
 */
export const OriginCheck = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* checkOrigin() {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (isSameOrigin(request)) {
        return yield* httpEffect;
      }

      return ProblemDetails.toResponse({
        detail: "The request's Origin is not the origin of this app.",
        status: 403,
        title: "Forbidden",
        type: FOREIGN_ORIGIN_TYPE,
      });
    }),
  { global: true },
);
