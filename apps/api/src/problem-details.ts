import { Effect, Option, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse, ProblemDetails } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { AUTH_UNAVAILABLE_RETRY_AFTER_S } from "./config.ts";

/**
 * Provide the `ProblemDetails` middleware of the root `HttpApi`, built once per Worker from the
 * `PROBLEM_DETAILS_INCLUDE` knob.
 *
 * A request that fails to decode becomes a 400 problem with a generic `detail`. With
 * `includeDetails` it also lists each issue's path and message; the list never echoes the value the
 * caller sent.
 *
 * @param options - The layer's settings.
 * @param options.includeDetails - Whether a 400 body lists the validation issues.
 * @returns The layer that implements `HttpApiMiddleware.ProblemDetails`.
 */
export const layerProblemDetails = (options: { readonly includeDetails: boolean }) =>
  HttpApiMiddleware.layerProblemDetails({ includeDetails: options.includeDetails });

/**
 * The IANA status phrases of the 4xx and 5xx codes, the only data the adapter holds.
 */
const STATUS_PHRASES = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [407, "Proxy Authentication Required"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [411, "Length Required"],
  [412, "Precondition Failed"],
  [413, "Content Too Large"],
  [414, "URI Too Long"],
  [415, "Unsupported Media Type"],
  [416, "Range Not Satisfiable"],
  [417, "Expectation Failed"],
  [421, "Misdirected Request"],
  [422, "Unprocessable Content"],
  [423, "Locked"],
  [424, "Failed Dependency"],
  [425, "Too Early"],
  [426, "Upgrade Required"],
  [428, "Precondition Required"],
  [429, "Too Many Requests"],
  [431, "Request Header Fields Too Large"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
  [505, "HTTP Version Not Supported"],
  [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"],
  [508, "Loop Detected"],
  [510, "Not Extended"],
  [511, "Network Authentication Required"],
]);

/**
 * The `type` of the problem that `AuthUnavailable` renders, the one body the adapter adds a header
 * to.
 */
const AUTH_UNAVAILABLE_TYPE = "/problems/auth-unavailable";

/**
 * The only member of a problem body the adapter reads.
 */
const ProblemType = Schema.fromJsonString(Schema.Struct({ type: Schema.String }));

/**
 * Report whether a response already carries a problem body.
 *
 * @param response - The response about to be sent.
 * @returns `true` when its content type is `application/problem+json`.
 */
const isProblem = (response: HttpServerResponse.HttpServerResponse): boolean =>
  response.headers["content-type"]?.startsWith(ProblemDetails.contentType) ?? false;

/**
 * Read the `type` of a problem response's JSON body.
 *
 * @param response - A response with an `application/problem+json` content type.
 * @returns The `type`, or none when the body is not a buffered JSON object that has one.
 */
const problemType = (response: HttpServerResponse.HttpServerResponse): Option.Option<string> =>
  response.body._tag === "Uint8Array"
    ? Option.map(
        Schema.decodeUnknownOption(ProblemType)(
          response.body.text ?? new TextDecoder().decode(response.body.body),
        ),
        ({ type }) => type,
      )
    : Option.none();

/**
 * Adapt one response about to be sent.
 *
 * A response of status 400 or above that is not a problem is replaced by a bare
 * `{ type: "about:blank", status, title }` problem, the title being the status's IANA phrase. A
 * problem passes through unchanged except that an `AuthUnavailable` body gains `Retry-After`.
 * Responses below 400 are untouched. The adapter never writes a `detail`, an extension or any other
 * `type`.
 *
 * @param _request - The request being answered, unused.
 * @param response - The response about to be sent.
 * @returns The response to send.
 */
const adapt = (
  _request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
) => {
  if (response.status < 400) {
    return Effect.succeed(response);
  }

  if (isProblem(response)) {
    return Effect.succeed(
      Option.getOrUndefined(problemType(response)) === AUTH_UNAVAILABLE_TYPE
        ? HttpServerResponse.setHeader(
            response,
            "retry-after",
            String(AUTH_UNAVAILABLE_RETRY_AFTER_S),
          )
        : response,
    );
  }

  return Effect.succeed(
    ProblemDetails.toResponse({
      status: response.status,
      title: STATUS_PHRASES.get(response.status) ?? "Error",
      type: ProblemDetails.blankType,
    }),
  );
};

/**
 * The pre-response adapter: a global router middleware that registers {@link adapt} for every
 * request, so the responses the framework sends without a problem body (an unrouted path, a body
 * over the limit, an unsupported media type, a defect, a built-in error) are still
 * `application/problem+json`.
 *
 * The adapter acts on the response, not the failure, so the error reporter still receives the
 * original cause.
 */
export const ProblemAdapter = HttpRouter.middleware(
  (httpEffect) => Effect.andThen(HttpEffect.appendPreResponseHandler(adapt), httpEffect),
  { global: true },
);
