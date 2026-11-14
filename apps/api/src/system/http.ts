import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "@workspace/contract/api/api";
import { SessionLookup } from "../authorization.ts";

/**
 * The handlers of the system group. `GET /api/session` declares no middleware, so the handler asks
 * `auth` through {@link SessionLookup} and answers `null` when the caller is signed out.
 *
 * The endpoint declares no error, so a fault of the lookup is raised as a defect carrying the
 * `AuthUnavailable` problem: a problem renders itself as its 503 response whether or not the
 * endpoint declares it.
 */
export const SystemApiHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn("system.handlers")(function* handlers(group) {
    const lookup = yield* SessionLookup;

    return group.handleAll({
      health: () => Effect.succeed({ ok: true } as const),
      session: Effect.fn("system.session")(function* session() {
        return yield* lookup.current.pipe(Effect.orDie);
      }),
    });
  }),
);
