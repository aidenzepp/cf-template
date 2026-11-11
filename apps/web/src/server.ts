import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkerBindings, isKvReader } from "@workspace/config/web-guard";
import { CREDENTIAL_ROUTES } from "@workspace/contract/domain/auth-endpoints";
import { forward, forwardTarget } from "./forward.ts";
import { refusal } from "./guard.ts";
import { checkRateLimit } from "./ratelimit.ts";
import { WebRequestLayers } from "./request-layers.ts";
import { run, structuredLogs } from "./runtime.ts";

/**
 * The runtime of the block layers of `web`. It builds them on the first request of an isolate from
 * the Worker's `env` and keeps them, so a block's per-isolate memory lasts as long as the isolate.
 */
const blocks = ManagedRuntime.make(
  Layer.mergeAll(structuredLogs, WebRequestLayers).pipe(
    Layer.provide(
      Layer.succeed(WorkerBindings, {
        kv: (name) => {
          const found = Object.entries(env).find(([key]) => key === name)?.[1];

          return isKvReader(found) ? found : undefined;
        },
      }),
    ),
  ),
);

/**
 * The server entry of `web`: a path under {@link FORWARD_PREFIXES} goes to its service binding
 * before TanStack sees it, and everything else is TanStack's. A failed forward renders
 * `/unavailable` through the same handler, carrying only the inbound `Cookie` header.
 *
 * A block's request guard runs first, so a latched request costs one memoized read; the rate-limit
 * check follows, before the forward and before the tracing layer: a refused request is answered
 * with the 429 and nothing else.
 */
export default createServerEntry({
  fetch: async (request, options) => {
    const guarded = await blocks.runPromise(refusal(request));

    if (guarded !== undefined) {
      return guarded;
    }

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
