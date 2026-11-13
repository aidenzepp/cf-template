import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { DocsEnabledKnob, DocsLiveRead } from "@workspace/config/docs";
import { WorkerBindings, isKvReader } from "@workspace/config/web-guard";
import { DESIGN_PATH, LLMS_PATH } from "@workspace/contract/api/docs-paths";
import { CREDENTIAL_ROUTES } from "@workspace/contract/domain/auth-endpoints";
import DESIGN_MD from "../../../DESIGN.md?raw";
import { forward, forwardTarget } from "./forward.ts";
import { webKnobs } from "./live-knobs.ts";
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
 * Whether the documentation surfaces answer: `DOCS_ENABLED`, read live on every request where
 * `DOCS_LIVE_READ` is on and final at its deploy-time value where it is off.
 */
const docsOn = Effect.gen(function* readDocsKnob() {
  const live = yield* DocsLiveRead;
  const deployed = yield* DocsEnabledKnob.config;

  return live ? yield* yield* webKnobs(env.KNOBS).bind(DocsEnabledKnob) : deployed;
}).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))), Effect.orDie);

/**
 * The server entry of `web`: a path under {@link FORWARD_PREFIXES} goes to its service binding
 * before TanStack sees it, and everything else is TanStack's. A failed forward answers 502.
 *
 * `GET /design.md` is answered here, from the `DESIGN.md` bundled at build time, while
 * `DOCS_ENABLED` is on; while it is off the request is TanStack's, which answers the not-found of
 * any unrouted path.
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

    const { pathname } = new URL(request.url);

    if (pathname === DESIGN_PATH && request.method === "GET" && (await run(docsOn))) {
      return new Response(DESIGN_MD, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    const target = forwardTarget(pathname);

    if (target === undefined) {
      return await handler.fetch(request, options);
    }

    const forwarded = await run(forward(env[target], request), { signal: request.signal });

    // `api` answers `/llms.txt` 404 while its docs are off. That path sits outside `/api`, so the
    // answer is `web`'s own not-found, as for every other path no one routes.
    return forwarded.status === 404 && pathname === LLMS_PATH
      ? await handler.fetch(request, options)
      : forwarded;
  },
});
