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
    const which = headers.get("x-test-web");
    const target =
      which === "bad-auth-methods" ? env.WEB_BAD : which === "github" ? env.WEB_GITHUB : env.WEB;
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

    const server = path.join(web, "dist", "server");
    const client = path.join(web, "dist", "client");
    yield* fs.makeDirectory(path.join(client, "api"), { recursive: true });
    yield* fs.writeFileString(path.join(client, "api", "shadow.txt"), "static asset");

    const files = (yield* fs.readDirectory(server, { recursive: true }))
      .filter((file) => file.endsWith(".js"))
      .toSorted((a, b) => Number(b === "server.js") - Number(a === "server.js"));

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
                compatibilityDate: COMPAT_DATE,
                modules: true,
                name: "driver",
                script: driverScript,
                serviceBindings: {
                  WEB: "web",
                  WEB_BAD: "web-bad-auth-methods",
                  WEB_GITHUB: "web-github",
                },
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
                  AUTH_METHODS: '{"email":false,"providers":["github"]}',
                  PUBLIC_ORIGIN: "http://x",
                },
                compatibilityDate: COMPAT_DATE,

                modules: files.map((file) => ({ path: path.join(server, file), type: "ESModule" })),
                modulesRoot: server,
                name: "web-github",
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
          catch: (cause) =>
            new HarnessError({
              message: `the harness request to ${target} did not complete: ${String(cause)}`,
            }),
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
    catch: (cause) =>
      new HarnessError({
        message: `the harness response body was not valid JSON: ${String(cause)}`,
      }),
    try: () => response.json(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      (cause) =>
        new HarnessError({
          message: `the harness response body did not match the expected schema: ${String(cause)}`,
        }),
    ),
  );

const text = (response: HarnessResponse) =>
  Effect.tryPromise({
    catch: (cause) =>
      new HarnessError({
        message: `the harness response body could not be read as text: ${String(cause)}`,
      }),
    try: () => response.text(),
  });

/**
 * Load a page with a cookie the stub reads and return it.
 */
const sessionState = (cookie: string, path = "/") =>
  Effect.gen(function* state() {
    const web = yield* WebProd;
    const response = yield* web.request(path, { headers: { accept: "text/html", cookie } });
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

  it.effect("strips spoofable client-address headers and keeps cf-connecting-ip", () =>
    Effect.gen(function* spoof() {
      const web = yield* WebProd;

      const body = yield* web
        .request("/auth/x", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            forwarded: "for=198.51.100.1",
            "x-forwarded-for": "198.51.100.1",
            "x-real-ip": "198.51.100.1",
          },
        })
        .pipe(Effect.flatMap((response) => decodeBody(Echo, response)));

      expect(body.headers["cf-connecting-ip"]).toBe("203.0.113.7");
      expect(body.headers["x-forwarded-for"]).toBeUndefined();
      expect(body.headers["x-real-ip"]).toBeUndefined();
      expect(body.headers.forwarded).toBeUndefined();
    }),
  );

  it.effect("answers 502 HTML to a navigation when the binding throws", () =>
    Effect.gen(function* html() {
      const web = yield* WebProd;
      const response = yield* web.request("/api/throws", { headers: { accept: "text/html" } });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("vary")).toBe("Sec-Fetch-Mode, Accept");
      expect(yield* text(response)).toContain("Sign-in is unavailable right now.");
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
      expect(yield* decodeBody(Problem, response)).toStrictEqual({
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

      const home = yield* web.request("/", {
        headers: { accept: "text/html", cookie: "stub=in" },
      });

      const missing = yield* web.request("/missing", {
        headers: { accept: "text/html", cookie: "stub=in" },
      });

      expect(home.status).toBe(200);
      expect(yield* text(home)).toContain("<main>web</main>");
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

        expect(response.headers.getSetCookie()).toStrictEqual([
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

      const response = yield* web.request("/api", {
        headers: { accept: "text/html", cookie: "stub=in" },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
    }),
  );

  it.effect("OBSERVED: an encoded /%61pi/health is not forwarded, it is TanStack's 404", () =>
    Effect.gen(function* encoded() {
      const web = yield* WebProd;

      const response = yield* web.request("/%61pi/health", {
        headers: { accept: "text/html", cookie: "stub=in" },
      });

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
      for (const cookie of ["stub=401", "stub=none"]) {
        expect((yield* sessionState(cookie, "/sign-in")).html).toContain(
          'data-session="signedOut"',
        );
      }
    }),
  );

  it.effect("answers a 503 session read with 503 and the retry screen", () =>
    Effect.gen(function* unavailable() {
      const { html, status } = yield* sessionState("stub=503");

      expect(status).toBe(503);
      expect(html).toContain("We could not check your sign-in.");
    }),
  );

  it.effect("shows the retry screen, never a redirect, on a transport or decode fault", () =>
    Effect.gen(function* faults() {
      expect((yield* sessionState("stub=throw")).html).toContain(
        "We could not check your sign-in.",
      );
      expect((yield* sessionState("stub=bad")).html).toContain("We could not check your sign-in.");
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

  it.effect("renders the sign-in and sign-up forms with zero provider buttons", () =>
    Effect.gen(function* screens() {
      const web = yield* WebProd;

      for (const path of ["/sign-in", "/sign-up?redirect=%2Fnotes"]) {
        const response = yield* web.request(path, { headers: { accept: "text/html" } });
        const html = yield* text(response);

        expect(response.status).toBe(200);
        expect(html).toContain('type="email"');
        expect(html).toContain('type="password"');
        expect(html).not.toContain("Continue with");
      }
    }),
  );

  it.effect("shows the no-email copy on sign-in and sign-up when email is off", () =>
    Effect.gen(function* copy() {
      const web = yield* WebProd;

      const read = (path: string) =>
        web.request(path, { headers: { accept: "text/html" } }).pipe(
          Effect.flatMap(text),
          Effect.map((html) => html.replaceAll("&#x27;", "'")),
        );

      expect(yield* read("/sign-in")).toContain(
        "Forgot your password? It can't be reset on this site yet. If you added a passkey or linked an account, sign in with that.",
      );
      expect(yield* read("/sign-up")).toContain(
        "Add a passkey in Settings after you sign up. Without email it is your way back in if you forget your password.",
      );
    }),
  );

  it.effect("renders one GitHub button for providers [github]", () =>
    Effect.gen(function* github() {
      const web = yield* WebProd;

      const response = yield* web.request("/sign-in", {
        headers: { accept: "text/html", "x-test-web": "github" },
      });

      const html = yield* text(response);

      expect(html.match(/Continue with/gu)).toHaveLength(1);
      expect(html).toContain("Continue with GitHub");
    }),
  );

  it.effect("renders /oauth-error with fixed copy for an allowlisted code", () =>
    Effect.gen(function* known() {
      const web = yield* WebProd;

      const response = yield* web.request("/oauth-error?error=access_denied", {
        headers: { accept: "text/html" },
      });

      expect(response.status).toBe(200);
      expect(yield* text(response)).toContain("Sign-in was cancelled.");
    }),
  );

  it.effect("renders only the generic copy for a crafted /oauth-error query", () =>
    Effect.gen(function* crafted() {
      const web = yield* WebProd;

      const query = new URLSearchParams({
        error: "<script>alert(1)</script>",
        error_description: "<img src=x onerror=alert(1)> leak-token-0a1b2c3d4e5f",
        extra: "leak-extra-6a7b8c9d0e1f",
      });

      const first = yield* web.request(`/oauth-error?${query.toString()}`, {
        headers: { accept: "text/html" },
      });

      const firstHtml = yield* text(first);
      const location = first.headers.get("location") ?? "";

      // The router canonicalizes the URL: the crafted values leave the address bar and the page.
      expect(first.status).toBe(307);
      expect(location).not.toMatch(/alert|leak-/u);
      expect(firstHtml).not.toContain("leak-");

      const response = yield* web.request(location, { headers: { accept: "text/html" } });
      const html = (yield* text(response)).replaceAll("&#x27;", "'");

      expect(response.status).toBe(200);
      expect(html).toContain("Sign-in didn't finish. Try again.");

      for (const leaked of ["alert(1)", "onerror", "leak-", "script>alert"]) {
        expect(html).not.toContain(leaked);
      }
    }),
  );

  it.effect("redirects a signed-in visit to /sign-in or /sign-up to /", () =>
    Effect.gen(function* signedIn() {
      const web = yield* WebProd;

      for (const path of ["/sign-in", "/sign-up"]) {
        const response = yield* web.request(path, {
          headers: { accept: "text/html", cookie: "stub=in" },
        });

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("/");
      }
    }),
  );

  it.effect("redirects a signedOut / root-relative to /sign-in?redirect=%2F", () =>
    Effect.gen(function* signedOutHome() {
      const web = yield* WebProd;

      for (const cookie of ["stub=401", "stub=none"]) {
        const response = yield* web.request("/", { headers: { accept: "text/html", cookie } });

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("/sign-in?redirect=%2F");
      }
    }),
  );

  it.effect(
    "renders / with the retry screen for unknown, never redirecting or showing Sign in",
    () =>
      Effect.gen(function* unknownHome() {
        const { html, status } = yield* sessionState("stub=503");

        expect(status).toBe(503);
        expect(html).toContain("We could not check your sign-in.");
        expect(html).not.toContain("Sign in");
      }),
  );

  it.effect("paints the skeleton, not the menu or Sign in, on a signedIn full load", () =>
    Effect.gen(function* signedInHome() {
      const { html, status } = yield* sessionState("stub=in");

      expect(status).toBe(200);

      for (const shown of [
        'data-session="signedIn"',
        'aria-label="Loading account"',
        'aria-label="Main"',
        ">Home<",
      ]) {
        expect(html).toContain(shown);
      }

      for (const hidden of ["Account menu", "Sign in"]) {
        expect(html).not.toContain(hidden);
      }
    }),
  );

  it.effect("shows Sign in in the signedOut shell and sets the theme script", () =>
    Effect.gen(function* signedOutShell() {
      const { html } = yield* sessionState("stub=401", "/sign-in");

      expect(html).toContain('href="/sign-in"');
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).not.toContain('aria-label="Main"');
    }),
  );

  it.effect("sets Cache-Control: private, no-store on every HTML response", () =>
    Effect.gen(function* noStore() {
      const web = yield* WebProd;

      for (const [path, cookie] of [
        ["/", "stub=in"],
        ["/sign-in", "stub=401"],
        ["/sign-up", "stub=401"],
        ["/missing", "stub=in"],
      ] as const) {
        const response = yield* web.request(path, { headers: { accept: "text/html", cookie } });

        expect([path, response.headers.get("cache-control")]).toStrictEqual([
          path,
          "private, no-store",
        ]);
      }
    }),
  );
});
