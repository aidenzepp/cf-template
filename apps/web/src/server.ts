import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Effect } from "effect";
import { forward, forwardTarget } from "./forward.ts";
import { run } from "./runtime.ts";

/**
 * The server entry of `web`: a path under {@link FORWARD_PREFIXES} goes to its service binding
 * before TanStack sees it, and everything else is TanStack's. A failed forward renders
 * `/unavailable` through the same handler, carrying only the inbound `Cookie` header.
 */
export default createServerEntry({
  fetch: (request, options) => {
    const target = forwardTarget(new URL(request.url).pathname);

    if (target === undefined) {
      return handler.fetch(request, options);
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

    return run(forward(env[target], request, render), { signal: request.signal });
  },
});
