import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { forward, forwardTarget } from "./forward.ts";
import { run } from "./runtime.ts";

/**
 * The server entry of `web`: a path under {@link FORWARD_PREFIXES} goes to its service binding
 * before TanStack sees it, and everything else is TanStack's.
 */
export default createServerEntry({
  fetch: (request, options) => {
    const target = forwardTarget(new URL(request.url).pathname);

    return target === undefined
      ? handler.fetch(request, options)
      : run(forward(env[target], request), { signal: request.signal });
  },
});
