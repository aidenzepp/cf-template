import { Effect, Option } from "effect";
import { RequestGuard } from "@workspace/config/web-guard";

/**
 * The refusal of the request guard, if a block provides one.
 *
 * With no `RequestGuard` in the context nothing refuses. The guard never fails, so a request is
 * either refused with the guard's own response or served.
 *
 * @param request - The inbound request.
 * @returns The response that refuses the request, else `undefined`.
 */
export const refusal = (request: Request): Effect.Effect<Response | undefined> =>
  Effect.serviceOption(RequestGuard).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(undefined),
        onSome: (guard) => guard.check(request),
      }),
    ),
  );
