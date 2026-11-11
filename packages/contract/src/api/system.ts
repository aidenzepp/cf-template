import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Session } from "../domain/session.ts";

/**
 * Session and health endpoints; declares no middleware, so both are open to anonymous callers.
 */
export const SystemApi = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("session", "/api/session", { success: Schema.NullOr(Session) }),
  HttpApiEndpoint.get("health", "/api/health", {
    success: Schema.Struct({ ok: Schema.Literal(true) }),
  }),
);
