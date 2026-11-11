import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Effect } from "effect";
import { CREDENTIAL_ROUTES } from "@workspace/contract/domain/auth-endpoints";
import { forward, forwardTarget } from "./forward.ts";
import { checkRateLimit } from "./ratelimit.ts";
import { run } from "./runtime.ts";

/**
 * The server entry of `web`: a path under {@link FORWARD_PREFIXES} goes to its service binding
 * before TanStack sees it, and everything else is TanStack's. A failed forward renders
 * `/unavailable` through the same handler, carrying only the inbound `Cookie` header.
 *
 * The rate-limit check runs first, before the forward and before the tracing layer: a refused
 * request is answered with the 429 and nothing else.
 */
export default createServerEntry({
  fetch: async (request, options) => {
    const refused = await Effect.runPromise(checkRateLimit(request, env, CREDENTIAL_ROUTES));

    if (refused !== null) {
      return refused;
    }

    const target = forwardTarget(new URL(request.url).pathname);

    if (target === undefined) {
      return await handler.fetch(request, options);
    }

    const cookie = request.headers.get("cookie");

    const render = Effect.promise(() =>
      Promise.resolve(
        handler.fetch(
          new Request(new URL("/unavailable", request.url), {
            headers: cookie === null ? {} : { cookie },
          }),
          options,
        ),
      ),
    );

    return await run(forward(env[target], request, render), { signal: request.signal });
  },
});
