import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare } from "miniflare";
import { FORWARD_PREFIXES } from "./forward-prefixes.ts";

/**
 * The response type of a Miniflare dispatch, which is not the global `Response`.
 */
type HarnessResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

/**
 * The failure of the harness itself: the build or the workerd runtime did not start.
 */
class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  message: Schema.String,
}) {}

/**
 * The compatibility date of every Worker, as `infra/src/compat.ts` sets it. `apps/web` cannot
 * import `infra` (its `rootDir` is `src`), so a bump there is repeated here.
 */
const COMPAT_DATE = "2026-10-26";

/**
 * A stub service binding. It answers `404` for `/missing`, throws for `/throws`, and echoes what it
 * received as JSON for every other path.
 */
const stubScript = (name: string) => `
let sessionReads = 0;
const session = {
  email: "a@b.test",
  expiresAt: "2030-01-01T00:00:00.000Z",
  image: null,
  name: "A",
  userId: "u1",
};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      sessionReads += 1;
      const mode = /(?:^|; )stub=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
      if (mode === "throw") throw new Error("stub failure");
      if (mode === "503") return new Response("down", { headers: { "retry-after": "7" }, status: 503 });
      if (mode === "401") return new Response("no", { status: 401 });
      if (mode === "bad") return Response.json({ nope: true });
      return Response.json(mode === "in" ? session : null);
    }
    if (url.pathname === "/api/session-reads") return Response.json({ reads: sessionReads });
    if (url.pathname.endsWith("/throws")) throw new Error("stub failure");
    if (url.pathname.endsWith("/missing")) return new Response("nope", { status: 404 });
    if (url.pathname.endsWith("/redirect")) {
      return new Response(null, { status: 302, headers: { location: "/elsewhere?x=1" } });
    }
    if (url.pathname.endsWith("/cookies")) {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/; HttpOnly; Secure; SameSite=Lax");
      headers.append("set-cookie", "a=; Path=/old; Max-Age=0");
      headers.append("set-cookie", "__Secure-b=2; Path=/; Secure; Partitioned; Priority=High");
      return new Response("ok", { headers });
    }
    return Response.json({
      binding: ${JSON.stringify(name)},
      body: await request.text(),
      cookie: request.headers.get("cookie"),
      headers: Object.fromEntries(request.headers),
      method: request.method,
      path: url.pathname + url.search,
      traceparent: request.headers.get("traceparent"),
      tracestate: request.headers.get("tracestate"),
      b3: request.headers.get("b3"),
    });
  },
};
`;

/**
 * The entry of the harness: it forwards each request to `web` and turns `x-test-sec-fetch-mode`
 * into `Sec-Fetch-Mode`, which a browser sets and the Node fetch of the test overwrites.
 */
const driverScript = `
export default {
  fetch(request, env) {
    const headers = new Headers(request.headers);
    const mode = headers.get("x-test-sec-fetch-mode");
    headers.delete("x-test-sec-fetch-mode");
    if (mode !== null) headers.set("sec-fetch-mode", mode);
    const target = headers.get("x-test-web") === "bad-auth-methods" ? env.WEB_BAD : env.WEB;
    headers.delete("x-test-web");
    return target.fetch(new Request(request, { headers, redirect: "manual" }));
  },
};
`;

/**
 * The production bundle of `web` on workerd with stub `API` and `AUTH` bindings: the `WebProd`
 * harness that `infra/src/web.ts` declares for the `local` kind, run here without Alchemy so the
 * stubs can answer.
 */
class WebProd extends Context.Service<
  WebProd,
  {
    readonly request: (
      path: string,
      init?: {
        readonly body?: string;
        readonly headers?: Record<string, string>;
        readonly method?: string;
      },
    ) => Effect.Effect<HarnessResponse, HarnessError>;
  }
>()("@workspace/web/WebProd") {}

const WebProdLive = Layer.effect(WebProd)(
  Effect.gen(function* makeHarness() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const web = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const build = yield* spawner
      .exitCode(ChildProcess.make("bun", ["run", "build:prod-harness"], { cwd: web }))
      .pipe(Effect.mapError((cause) => new HarnessError({ message: cause.message })));

    if (build !== 0) {
      return yield* new HarnessError({ message: `build:prod-harness exited ${build}` });
    }

    const server = path.join(web, "dist", "server");
    const client = path.join(web, "dist", "client");
    yield* fs.makeDirectory(path.join(client, "api"), { recursive: true });
    yield* fs.writeFileString(path.join(client, "api", "shadow.txt"), "static asset");

    const files = (yield* fs.readDirectory(server, { recursive: true }))
      .filter((file) => file.endsWith(".js"))
      .toSorted((a, b) => Number(b === "server.js") - Number(a === "server.js"));

    const mf = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) => new HarnessError({ message: String(cause) }),
        try: async () => {
          const instance = new Miniflare({
            workers: [
              {
                compatibilityDate: COMPAT_DATE,
                modules: true,
                name: "driver",
                script: driverScript,
                serviceBindings: { WEB: "web", WEB_BAD: "web-bad-auth-methods" },
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
                  AUTH_METHODS: '{"email":false,"providers":[]}',
                  PUBLIC_ORIGIN: "http://x",
                },
                compatibilityDate: COMPAT_DATE,

                modules: files.map((file) => ({ path: path.join(server, file), type: "ESModule" })),
                modulesRoot: server,
                name: "web",
                serviceBindings: { API: "api", AUTH: "auth" },
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
                  AUTH_METHODS: "{nope",
                  PUBLIC_ORIGIN: "http://x",
                },
                compatibilityDate: COMPAT_DATE,

                modules: files.map((file) => ({ path: path.join(server, file), type: "ESModule" })),
                modulesRoot: server,
                name: "web-bad-auth-methods",
                serviceBindings: { API: "api", AUTH: "auth" },
              },
              {
                compatibilityDate: COMPAT_DATE,
                modules: true,
                name: "api",
                script: stubScript("api"),
              },
              {
                compatibilityDate: COMPAT_DATE,
                modules: true,
                name: "auth",
                script: stubScript("auth"),
              },
            ],
          });

          await instance.ready;

          return instance;
        },
      }),
      (instance) => Effect.promise(() => instance.dispose()),
    );

    return WebProd.of({
      request: (target, init) =>
        Effect.tryPromise({
          catch: (cause) => new HarnessError({ message: String(cause) }),
          try: () => mf.dispatchFetch(`http://web.test${target}`, { redirect: "manual", ...init }),
        }),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

const Echo = Schema.Struct({
  b3: Schema.NullOr(Schema.String),
  binding: Schema.String,
  body: Schema.String,
  cookie: Schema.NullOr(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  method: Schema.String,
  path: Schema.String,
  traceparent: Schema.NullOr(Schema.String),
  tracestate: Schema.NullOr(Schema.String),
});

const Problem = Schema.Struct({ status: Schema.Number, title: Schema.String, type: Schema.String });

const decodeBody = <S extends Schema.Decoder<unknown>>(schema: S, response: HarnessResponse) =>
  Effect.tryPromise({
    catch: (cause) => new HarnessError({ message: String(cause) }),
    try: () => response.json(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new HarnessError({ message: String(cause) })),
  );

const text = (response: HarnessResponse) =>
  Effect.tryPromise({
    catch: (cause) => new HarnessError({ message: String(cause) }),
    try: () => response.text(),
  });

/**
 * Load `/` with a cookie the stub reads and return the page.
 */
const sessionState = (cookie: string) =>
  Effect.gen(function* state() {
    const web = yield* WebProd;
    const response = yield* web.request("/", { headers: { accept: "text/html", cookie } });
    const html = yield* text(response);

    return { html, status: response.status };
  });

layer(WebProdLive, { timeout: 120_000 })("WebProd", (it) => {
  const traced = {
    b3: "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1",
    cookie: "a=1; b=2",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    tracestate: "k=v",
  };

  it.effect("forwards /api/* to API with cookies and without trace headers", () =>
    Effect.gen(function* api() {
      const web = yield* WebProd;

      const body = yield* web
        .request("/api/x?q=1", { headers: traced })
        .pipe(Effect.flatMap((response) => decodeBody(Echo, response)));

      expect(body).toMatchObject({
        b3: null,
        binding: "api",
        cookie: "a=1; b=2",
        path: "/api/x?q=1",
        traceparent: null,
        tracestate: null,
      });
    }),
  );

  it.effect("forwards /auth/* to AUTH with cookies and without trace headers", () =>
    Effect.gen(function* auth() {
      const web = yield* WebProd;

      const body = yield* web
        .request("/auth/x", { headers: traced })
        .pipe(Effect.flatMap((response) => decodeBody(Echo, response)));

      expect(body).toMatchObject({ binding: "auth", cookie: "a=1; b=2", traceparent: null });
    }),
  );

  it.effect("answers 502 HTML to a navigation when the binding throws", () =>
    Effect.gen(function* html() {
      const web = yield* WebProd;
      const response = yield* web.request("/api/throws", { headers: { accept: "text/html" } });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("vary")).toBe("Sec-Fetch-Mode, Accept");
      expect(yield* text(response)).toContain("<h1>Bad Gateway</h1>");
    }),
  );

  it.effect("answers 502 HTML when Sec-Fetch-Mode is navigate", () =>
    Effect.gen(function* navigate() {
      const web = yield* WebProd;

      const response = yield* web.request("/auth/throws", {
        headers: { "x-test-sec-fetch-mode": "navigate" },
      });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/html");
    }),
  );

  it.effect("answers 502 problem+json to any other caller when the binding throws", () =>
    Effect.gen(function* problem() {
      const web = yield* WebProd;

      const response = yield* web.request("/api/throws", {
        headers: { accept: "application/json" },
      });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("vary")).toBe("Sec-Fetch-Mode, Accept");
      expect(yield* decodeBody(Problem, response)).toEqual({
        status: 502,
        title: "Bad Gateway",
        type: "about:blank",
      });
    }),
  );

  it.effect("passes a 404 from the binding through unchanged", () =>
    Effect.gen(function* notFound() {
      const web = yield* WebProd;
      const response = yield* web.request("/api/missing");

      expect(response.status).toBe(404);
      expect(yield* text(response)).toBe("nope");
    }),
  );

  it.effect("answers GET / from TanStack and GET /missing with TanStack's 404", () =>
    Effect.gen(function* pages() {
      const web = yield* WebProd;
      const home = yield* web.request("/", { headers: { accept: "text/html" } });
      const missing = yield* web.request("/missing", { headers: { accept: "text/html" } });

      expect(home.status).toBe(200);
      expect(yield* text(home)).toContain('<main data-session="signedOut">web</main>');
      expect(missing.status).toBe(404);
    }),
  );

  it.effect("does not serve a static file under /api/", () =>
    Effect.gen(function* shadow() {
      const web = yield* WebProd;

      const body = yield* web
        .request("/api/shadow.txt")
        .pipe(Effect.flatMap((response) => decodeBody(Echo, response)));

      expect(body).toMatchObject({ binding: "api", path: "/api/shadow.txt" });
    }),
  );

  it.effect("keeps a POST body, its method and arbitrary request headers intact", () =>
    Effect.gen(function* post() {
      const web = yield* WebProd;

      const body = yield* web
        .request("/api/notes", {
          body: '{"title":"t"}',
          headers: {
            authorization: "Bearer probe",
            "content-type": "application/json",
            origin: "https://example.test",
            "x-custom": "kept",
          },
          method: "POST",
        })
        .pipe(Effect.flatMap((response) => decodeBody(Echo, response)));

      expect(body.method).toBe("POST");
      expect(body.body).toBe('{"title":"t"}');
      expect(body.headers).toMatchObject({
        authorization: "Bearer probe",
        "content-type": "application/json",
        origin: "https://example.test",
        "x-custom": "kept",
      });
    }),
  );

  it.effect(
    "delivers every Set-Cookie line of the backend unchanged, same-name cookies included",
    () =>
      Effect.gen(function* cookies() {
        const web = yield* WebProd;
        const response = yield* web.request("/auth/cookies");

        expect(response.status).toBe(200);

        expect(response.headers.getSetCookie()).toEqual([
          "a=1; Path=/; HttpOnly; Secure; SameSite=Lax",
          "a=; Path=/old; Max-Age=0",
          "__Secure-b=2; Path=/; Secure; Partitioned; Priority=High",
        ]);
      }),
  );

  it.effect("passes a 302 and its Location through without following it", () =>
    Effect.gen(function* redirect() {
      const web = yield* WebProd;
      const response = yield* web.request("/api/redirect");

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/elsewhere?x=1");
    }),
  );

  it.effect("does not forward bare /api, which matches no prefix and is TanStack's 404", () =>
    Effect.gen(function* bare() {
      const web = yield* WebProd;
      const response = yield* web.request("/api", { headers: { accept: "text/html" } });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
    }),
  );

  it.effect("OBSERVED: an encoded /%61pi/health is not forwarded, it is TanStack's 404", () =>
    Effect.gen(function* encoded() {
      const web = yield* WebProd;
      const response = yield* web.request("/%61pi/health", { headers: { accept: "text/html" } });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
    }),
  );

  it.effect("reads the session once per full load with the inbound Cookie copied", () =>
    Effect.gen(function* once() {
      const web = yield* WebProd;

      const reads = () =>
        web
          .request("/api/session-reads")
          .pipe(
            Effect.flatMap((response) =>
              decodeBody(Schema.Struct({ reads: Schema.Number }), response),
            ),
          );

      const before = yield* reads();
      const { html } = yield* sessionState("stub=in");
      const after = yield* reads();

      expect(after.reads - before.reads).toBe(1);
      expect(html).toContain('data-session="signedIn"');
    }),
  );

  it.effect("derives signedOut from a 401 and from a null session", () =>
    Effect.gen(function* signedOut() {
      expect((yield* sessionState("stub=401")).html).toContain('data-session="signedOut"');
      expect((yield* sessionState("stub=none")).html).toContain('data-session="signedOut"');
    }),
  );

  it.effect("derives unknown from a 503, keeping Retry-After", () =>
    Effect.gen(function* unavailable() {
      const { html, status } = yield* sessionState("stub=503");

      expect(status).toBe(200);
      expect(html).toContain('data-session="unknown"');
      expect(html).toContain("retryAfter");
    }),
  );

  it.effect("derives unknown, never signedOut, from a transport or decode fault", () =>
    Effect.gen(function* faults() {
      expect((yield* sessionState("stub=throw")).html).toContain('data-session="unknown"');
      expect((yield* sessionState("stub=bad")).html).toContain('data-session="unknown"');
    }),
  );

  it.effect("fails the request, rendering no page, when AUTH_METHODS does not decode", () =>
    Effect.gen(function* invalid() {
      const web = yield* WebProd;

      const response = yield* web.request("/", {
        headers: { accept: "text/html", "x-test-web": "bad-auth-methods" },
      });

      const html = yield* text(response);

      expect(response.status).toBe(500);
      expect(html).not.toContain("data-session");
    }),
  );
});
