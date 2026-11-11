import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare } from "miniflare";
import { FORWARD_PREFIXES } from "../forward-prefixes.ts";
import { PROBLEM_COPY, PROBLEM_FALLBACK_TITLE } from "../lib/problem-copy.ts";

/**
 * The failure of the harness itself: the build or the workerd runtime did not start.
 */
class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  message: Schema.String,
}) {}

/**
 * The stub `API`. A session read answers by the `stub` cookie, records the `Cookie` it received and
 * the header names of the request, and a `200` carries a `Set-Cookie` so the no-relay assertion is
 * not vacuous. The stub `AUTH` throws on every request.
 */
const apiScript = `
let reads = 0;
let last = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session-reads") return Response.json({ reads, last });
    if (url.pathname !== "/api/session") return new Response("nope", { status: 404 });
    reads += 1;
    const cookie = request.headers.get("cookie");
    last = { cookie, names: [...request.headers.keys()].sort() };
    const mode = /(?:^|; )stub=([^;]*)/.exec(cookie ?? "")?.[1];
    if (mode === "401") return new Response("no", { status: 401 });
    if (mode === "503") return new Response("down", { headers: { "retry-after": "5" }, status: 503 });
    return Response.json(
      { email: "a@b.test", expiresAt: "2030-01-01T00:00:00.000Z", image: null, name: "A", userId: "u1" },
      { headers: { "set-cookie": "refreshed=1; Path=/; HttpOnly" } },
    );
  },
};
`;

const authScript = `export default { fetch() { throw new Error("stub AUTH failure"); } };`;

/**
 * The response type of a Miniflare dispatch, which is not the global `Response`.
 */
type HarnessResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

/**
 * The production bundle of `web` on workerd with the stub `API` and `AUTH`.
 */
class WebProd extends Context.Service<
  WebProd,
  {
    readonly get: (
      path: string,
      cookie?: string,
    ) => Effect.Effect<{ readonly html: string; readonly response: HarnessResponse }, HarnessError>;
  }
>()("@workspace/web/ProtectedRoutesWebProd") {}

const WebProdLive = Layer.effect(WebProd)(
  Effect.gen(function* makeHarness() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const web = yield* path.fromFileUrl(new URL("../..", import.meta.url));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Its own output directory: `server.test.ts` builds into `dist` in parallel, and a shared one
    // lets either build empty the other's bundle ("Modules list cannot be empty").
    const outDir = path.join(web, "node_modules", ".cache", "protected-routes-harness");

    const build = yield* spawner
      .exitCode(
        ChildProcess.make("bun", ["run", "build:prod-harness", "--outDir", outDir], { cwd: web }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              message: `the production harness build could not be spawned: ${cause.message}`,
            }),
        ),
      );

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
        catch: (cause) =>
          new HarnessError({
            message: `Miniflare could not start the web Worker: ${String(cause)}`,
          }),
        try: async () => {
          const instance = new Miniflare({
            workers: [
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
      get: (target, cookie) =>
        Effect.tryPromise({
          catch: (cause) =>
            new HarnessError({
              message: `the harness request to ${target} did not complete: ${String(cause)}`,
            }),
          try: async () => {
            const response = await mf.dispatchFetch(`http://web.test${target}`, {
              headers: { accept: "text/html", cookie: cookie ?? "" },
              redirect: "manual",
            });

            return { html: await response.text(), response };
          },
        }),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

const Reads = Schema.Struct({
  last: Schema.NullOr(Schema.Struct({ cookie: Schema.String, names: Schema.Array(Schema.String) })),
  reads: Schema.Number,
});

const readsOf = Effect.gen(function* readsOf() {
  const { html } = yield* (yield* WebProd).get("/api/session-reads");

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Reads))(html).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessError({
          message: `the session-reads response did not match the expected schema: ${String(cause)}`,
        }),
    ),
  );
});

layer(WebProdLive, { timeout: 120_000 })("protected routes", (it) => {
  it.effect("renders a signed-in reload, copies only the Cookie and relays no Set-Cookie", () =>
    Effect.gen(function* signedIn() {
      const { html, response } = yield* (yield* WebProd).get("/", "stub=in");

      expect(response.status).toBe(200);
      expect(html).toContain("<main>web</main>");
      expect(response.headers.get("set-cookie")).toBeNull();

      const { last } = yield* readsOf;

      expect(last?.cookie).toBe("stub=in");
      expect(
        last?.names.filter((name) => name === "authorization" || name === "x-forwarded-for"),
      ).toStrictEqual([]);
    }),
  );

  it.effect("fails closed on a 401 with a 307 to /sign-in carrying a root-relative redirect", () =>
    Effect.gen(function* signedOut() {
      const { response } = yield* (yield* WebProd).get("/not-a-page?a=1", "stub=401");

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/sign-in?redirect=%2Fnot-a-page%3Fa%3D1");
    }),
  );

  it.effect("does not carry a protocol-relative path into the redirect", () =>
    Effect.gen(function* protocolRelative() {
      const { response } = yield* (yield* WebProd).get("//evil.example/a", "stub=401");
      const location = new URL(response.headers.get("location") ?? "", "http://web.test");

      expect(location.origin).toBe("http://web.test");
      expect(location.searchParams.get("redirect") ?? "").not.toMatch(/^\/\//u);
    }),
  );

  it.effect("does not follow an absolute redirect value on /sign-in", () =>
    Effect.gen(function* absolute() {
      const web = yield* WebProd;

      const protocolRelative = yield* web.get("/sign-in?redirect=//evil.example", "stub=401");
      const absoluteUrl = yield* web.get("/sign-in?redirect=https://evil.example/", "stub=401");

      for (const { html, response } of [protocolRelative, absoluteUrl]) {
        // The router drops the rejected value and canonicalizes with a same-origin 307, or renders.
        expect([200, 307]).toContain(response.status);
        expect(response.headers.get("location") ?? "").not.toContain("evil.example");
        expect(html).not.toContain("evil.example");
      }
    }),
  );

  it.effect("does not redirect a signed-out caller away from an auth screen", () =>
    Effect.gen(function* authScreen() {
      const { response } = yield* (yield* WebProd).get("/sign-in", "stub=401");

      expect(response.status).toBe(200);
    }),
  );

  it.effect("answers 503 with Retry-After and the retry screen when the session read fails", () =>
    Effect.gen(function* unavailable() {
      const { html, response } = yield* (yield* WebProd).get("/", "stub=503");

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(response.headers.get("location")).toBeNull();
      expect(html).toContain("We could not check your sign-in.");
    }),
  );

  it.effect("renders the authored copy of each known problem slug", () =>
    Effect.gen(function* knownProblems() {
      const web = yield* WebProd;

      for (const [slug, text] of PROBLEM_COPY) {
        const { html, response } = yield* web.get(slug, "stub=in");

        expect(response.status).toBe(200);
        expect(html).toContain(text);
      }
    }),
  );

  it.effect("renders the fallback title for an unknown problem slug", () =>
    Effect.gen(function* unknownProblem() {
      const { html, response } = yield* (yield* WebProd).get("/problems/nope", "stub=in");

      expect(response.status).toBe(200);
      expect(html).toContain(PROBLEM_FALLBACK_TITLE);
    }),
  );

  it.effect("skips the session read on /unavailable", () =>
    Effect.gen(function* sessionLess() {
      const before = (yield* readsOf).reads;
      const { html, response } = yield* (yield* WebProd).get("/unavailable", "stub=401");

      expect(response.status).toBe(200);
      expect(html).toContain("Sign-in is unavailable right now.");
      expect((yield* readsOf).reads).toBe(before);
    }),
  );
});
