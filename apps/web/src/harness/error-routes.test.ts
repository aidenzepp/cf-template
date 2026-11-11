import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare } from "miniflare";
import { FORWARD_PREFIXES } from "../forward-prefixes.ts";

/**
 * The failure of the harness itself: the build or the workerd runtime did not start.
 */
class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  message: Schema.String,
}) {}

/**
 * The stub `API`: every session read answers a signed-in session. The stub `AUTH` is never reached.
 */
const apiScript = `
export default {
  fetch() {
    return Response.json({
      email: "a@b.test", expiresAt: "2030-01-01T00:00:00.000Z", image: null, name: "A", userId: "u1",
    });
  },
};
`;

const authScript = `export default { fetch() { throw new Error("auth is down"); } };`;

/**
 * The entry: it forwards each request to `web` and turns `x-test-sec-fetch-mode` into
 * `Sec-Fetch-Mode`, which a browser sets and the Node fetch of the test overwrites.
 */
const driverScript = `
export default {
  fetch(request, env) {
    const headers = new Headers(request.headers);
    const mode = headers.get("x-test-sec-fetch-mode");
    headers.delete("x-test-sec-fetch-mode");
    if (mode !== null) headers.set("sec-fetch-mode", mode);
    return env.WEB.fetch(new Request(request, { headers, redirect: "manual" }));
  },
};
`;

// The router stamps each match with the time it rendered; nothing else differs between renders.
const withoutClock = (html: string) => html.replaceAll(/u:\d+/gu, "u:0");

const HTML_ACCEPT = { accept: "text/html" } satisfies Record<string, string>;

/**
 * The response type of a Miniflare dispatch, which is not the global `Response`.
 */
type HarnessResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

/**
 * The production bundle of `web`, built with the `-harness/` fixtures registered, on workerd with
 * the stub `API` and `AUTH`.
 */
class WebProd extends Context.Service<
  WebProd,
  {
    readonly get: (
      path: string,
      headers?: Record<string, string>,
    ) => Effect.Effect<{ readonly html: string; readonly response: HarnessResponse }, HarnessError>;
  }
>()("@workspace/web/ErrorRoutesWebProd") {}

const WebProdLive = Layer.effect(WebProd)(
  Effect.gen(function* makeHarness() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const web = yield* path.fromFileUrl(new URL("../..", import.meta.url));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Its own output directory: the other harnesses build into theirs in parallel, and a shared one
    // lets either build empty the other's bundle.
    const outDir = path.join(web, "node_modules", ".cache", "error-routes-harness");

    const build = yield* spawner
      .exitCode(
        ChildProcess.make("bun", ["run", "build:prod-harness", "--outDir", outDir], {
          cwd: web,
          env: { WEB_HARNESS_ROUTES: "1" },
          extendEnv: true,
        }),
      )
      .pipe(Effect.mapError((cause) => new HarnessError({ message: cause.message })));

    if (build !== 0) {
      return yield* new HarnessError({ message: `build:prod-harness exited ${build}` });
    }

    const server = path.join(outDir, "server");
    const client = path.join(outDir, "client");

    const files = (yield* fs.readDirectory(server, { recursive: true })).filter((file) =>
      file.endsWith(".js"),
    );

    const mf = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) => new HarnessError({ message: String(cause) }),
        try: async () => {
          const instance = new Miniflare({
            workers: [
              {
                compatibilityDate: "2026-10-26",
                modules: true,
                name: "driver",
                script: driverScript,
                serviceBindings: { WEB: "web" },
              },
              {
                assets: {
                  directory: client,
                  routerConfig: {
                    has_user_worker: true,
                    static_routing: { user_worker: [...FORWARD_PREFIXES] },
                  },
                },
                bindings: {
                  AUTH_METHODS: '{"email":true,"providers":[]}',
                  PUBLIC_ORIGIN: "http://x",
                },
                compatibilityDate: "2026-10-26",
                modules: files.toSorted().map((file) => ({
                  path: path.join(server, file),
                  type: "ESModule" as const,
                })),
                modulesRoot: server,
                name: "web",
                serviceBindings: { API: "api", AUTH: "auth" },
              },
              { compatibilityDate: "2026-10-26", modules: true, name: "api", script: apiScript },
              { compatibilityDate: "2026-10-26", modules: true, name: "auth", script: authScript },
            ],
          });

          await instance.ready;

          return instance;
        },
      }),
      (instance) => Effect.promise(() => instance.dispose()),
    );

    return WebProd.of({
      get: (target, headers = HTML_ACCEPT) =>
        Effect.tryPromise({
          catch: (cause) => new HarnessError({ message: String(cause) }),
          try: async () => {
            const response = await mf.dispatchFetch(`http://web.test${target}`, {
              headers,
              redirect: "manual",
            });

            return { html: await response.text(), response };
          },
        }),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * The text `routes/-harness-throws.tsx` dies with; no page may show it.
 */
const HARNESS_DEFECT = "harness-defect-secret";

const NOT_FOUND_HEADING = "This page doesn&#x27;t exist.";

const ERROR_HEADING = "Something went wrong and the page couldn&#x27;t load.";

layer(WebProdLive, { timeout: 180_000 })("error routes", (it) => {
  it.effect("answers 404 with the not-found page for a path no route matches", () =>
    Effect.gen(function* missing() {
      const { html, response } = yield* (yield* WebProd).get("/missing");

      expect(response.status).toBe(404);
      expect(html).toContain(NOT_FOUND_HEADING);
      expect(html).toContain('href="/"');
      expect(html).toContain("Go to the home page");
    }),
  );

  it.effect("answers 404 with the same page when a loader reports its record missing", () =>
    Effect.gen(function* loaderNotFound() {
      const { html, response } = yield* (yield* WebProd).get("/-harness-throws?kind=not-found");

      expect(response.status).toBe(404);
      expect(html).toContain(NOT_FOUND_HEADING);
      expect(html).toContain('href="/"');
    }),
  );

  it.effect("answers 500 with the error page and none of the thrown text", () =>
    Effect.gen(function* loaderDefect() {
      const { html, response } = yield* (yield* WebProd).get("/-harness-throws");

      expect(response.status).toBe(500);
      expect(html).toContain(ERROR_HEADING);
      expect(html).toContain("Try again");
      expect(html).toContain("Go to the home page");
      // The whole document, the router's dehydrated state in `<script>` included.
      expect(html).not.toContain(HARNESS_DEFECT);
    }),
  );

  const callback = "/auth/callback/github";

  const OUTAGE_HEADING = "Sign-in is unavailable right now.";

  it.effect("answers a failed forward to a navigation with the /unavailable body", () =>
    Effect.gen(function* navigation() {
      const web = yield* WebProd;
      const page = yield* web.get("/unavailable");

      const navigations: readonly Record<string, string>[] = [
        { "x-test-sec-fetch-mode": "navigate" },
        { accept: "text/html" },
      ];

      for (const headers of navigations) {
        const { html, response } = yield* web.get(callback, headers);

        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("vary")).toBe("Sec-Fetch-Mode, Accept");
        expect(html).toContain(OUTAGE_HEADING);
        expect(withoutClock(html)).toBe(withoutClock(page.html));
      }
    }),
  );

  it.effect("answers a failed forward to a JSON caller with problem+json", () =>
    Effect.gen(function* json() {
      const { html, response } = yield* (yield* WebProd).get(callback, {
        accept: "application/json",
      });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(JSON.parse(html)).toEqual({ status: 502, title: "Bad Gateway", type: "about:blank" });
    }),
  );

  it.effect("renders the failed forward with the markup /unavailable renders for the cookie", () =>
    Effect.gen(function* themed() {
      const web = yield* WebProd;
      const headers = { accept: "text/html", cookie: "theme=dark" };
      const page = yield* web.get("/unavailable", headers);
      const failed = yield* web.get(callback, headers);

      expect(failed.response.status).toBe(502);
      expect(withoutClock(failed.html)).toBe(withoutClock(page.html));
      expect(failed.html).toContain(OUTAGE_HEADING);
    }),
  );
});
