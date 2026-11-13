import { Schema } from "effect";
import { HttpApiError } from "effect/http-api";

/**
 * The caller is over a front-door limit. The `web` Worker hand-encodes this body before any
 * `HttpApi` handler runs, so no endpoint declares it.
 */
export class RateLimited extends HttpApiError.Problem<RateLimited>()(
  "RateLimited",
  { status: 429, title: "Too many requests", type: "/problems/rate-limited" },
  { retryAfterSeconds: Schema.Finite },
) {}
