import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { RateLimited } from "@workspace/contract/domain/rate-limited";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare } from "miniflare";
import { FORWARD_PREFIXES } from "./forward-prefixes.ts";

/**
 * The failure of the harness itself: the build or the workerd runtime did not start.
 */
class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  message: Schema.String,
}) {}

/**
 * The part of the runtime's stderr stream the harness reads.
 */
interface StderrStream {
  readonly on: (event: "data", listener: (chunk: Uint8Array) => void) => void;
}

const apiScript = `export default { fetch() { return Response.json({}); } };`;

const authScript = `export default { fetch() { throw new Error("auth is down"); } };`;

/**
 * A stub limiter: it counts `limit` calls per key and refuses past `LIMIT`. The key `reject` makes
 * `limit` throw when `REJECTS` is `1`. Its `fetch` reports how many `limit` calls it received.
 */
const limiterScript = `
import { WorkerEntrypoint } from "cloudflare:workers";
const counts = new Map();
let calls = 0;
export class Limiter extends WorkerEntrypoint {
  async limit({ key }) {
    calls += 1;
    if (key === "reject" && this.env.REJECTS === "1") throw new Error("limiter is down");
    const seen = (counts.get(key) ?? 0) + 1;
    counts.set(key, seen);
    return { success: seen <= Number(this.env.LIMIT) };
  }
}
export default { fetch() { return Response.json({ calls }); } };
`;

const limiter = (name: string, limit: number, rejects: "0" | "1") => ({
  bindings: { LIMIT: limit, REJECTS: rejects },
  compatibilityDate: "2026-10-26",
  modules: true,
  name,
  script: limiterScript,
});

const driverScript = `
export default {
  fetch(request, env) {
    // workerd stamps every dispatch with its own address; the test chooses the caller instead.
    const headers = new Headers(request.headers);
    const ip = headers.get("x-test-ip");
    headers.delete("x-test-ip");
    headers.delete("cf-connecting-ip");
    if (ip !== null) headers.set("cf-connecting-ip", ip);
    return env.WEB.fetch(new Request(request, { headers, redirect: "manual" }));
  },
};
`;

/**
 * The response type of a Miniflare dispatch, which is not the global `Response`.
 */
type HarnessResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

/**
 * The production bundle of `web` on workerd, with the stub `API`, `AUTH` and limiters.
 */
class WebProd extends Context.Service<
  WebProd,
  {
    readonly send: (
      method: string,
      path: string,
      headers: Record<string, string>,
    ) => Effect.Effect<HarnessResponse, HarnessError>;
    readonly limiterCalls: (name: "credential" | "public") => Effect.Effect<number, HarnessError>;
    readonly stderr: () => ReadonlyArray<string>;
    readonly awaitStderr: (from: number, text: string) => Effect.Effect<string>;
  }
>()("@workspace/web/RateLimitWebProd") {}

const WebProdLive = Layer.effect(WebProd)(
  Effect.gen(function* makeHarness() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const web = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Its own output directory: the other harnesses build into theirs in parallel.
    const outDir = path.join(web, "node_modules", ".cache", "ratelimit-harness");

    const build = yield* spawner
      .exitCode(
        ChildProcess.make("bun", ["run", "build:prod-harness", "--outDir", outDir], {
          cwd: web,
          env: { WEB_HARNESS_ROUTES: "1" },
          extendEnv: true,
        }),
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

    const stderr: Array<string> = [];

    // Callbacks that re-check the stream when a chunk arrives: workerd delivers its stderr to this
    // process on its own schedule, after the response that caused the line.
    const watchers = new Set<() => void>();

    const mf = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) =>
          new HarnessError({
            message: `Miniflare could not start the web Worker: ${String(cause)}`,
          }),
        try: async () => {
          const instance = new Miniflare({
            handleRuntimeStdio: (_stdout: StderrStream, err: StderrStream) => {
              err.on("data", (chunk) => {
                stderr.push(new TextDecoder().decode(chunk));

                for (const notify of watchers) {
                  notify();
                }
              });
            },
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
                  STACK_NAME: "harness-stack",
                },
                compatibilityDate: "2026-10-26",
                modules: files.toSorted().map((file) => ({
                  path: path.join(server, file),
                  type: "ESModule" as const,
                })),
                modulesRoot: server,
                name: "web",
                serviceBindings: {
                  API: "api",
                  AUTH: "auth",
                  RATELIMIT_CREDENTIAL: { entrypoint: "Limiter", name: "limit-credential" },
                  RATELIMIT_PUBLIC: { entrypoint: "Limiter", name: "limit-public" },
                },
              },
              { compatibilityDate: "2026-10-26", modules: true, name: "api", script: apiScript },
              { compatibilityDate: "2026-10-26", modules: true, name: "auth", script: authScript },
              limiter("limit-credential", 5, "1"),
              limiter("limit-public", 100, "0"),
            ],
          });

          await instance.ready;

          return instance;
        },
      }),
      (instance) => Effect.promise(() => instance.dispose()),
    );

    return WebProd.of({
      awaitStderr: (from, text) =>
        Effect.callback<string>((resume) => {
          const check = () => {
            const output = stderr.slice(from).join("");

            if (output.includes(text)) {
              watchers.delete(check);
              resume(Effect.succeed(output));
            }
          };

          watchers.add(check);
          check();

          return Effect.sync(() => {
            watchers.delete(check);
          });
        }),
      limiterCalls: (name) => {
        const unreadable = (cause: unknown) =>
          new HarnessError({
            message: `the rate limiter call count for ${name} could not be read: ${String(cause)}`,
          });

        return Effect.tryPromise({
          catch: unreadable,
          try: async () => {
            const worker = await mf.getWorker(`limit-${name}`);
            const reply = await worker.fetch("http://limiter.test/");

            return await reply.json();
          },
        }).pipe(
          Effect.flatMap((body) =>
            Schema.decodeUnknownEffect(Schema.Struct({ calls: Schema.Number }))(body).pipe(
              Effect.mapError(unreadable),
            ),
          ),
          Effect.map(({ calls }) => calls),
        );
      },
      send: (method, target, headers) =>
        Effect.tryPromise({
          catch: (cause) =>
            new HarnessError({
              message: `the harness ${method} request to ${target} did not complete: ${String(cause)}`,
            }),
          try: () =>
            mf.dispatchFetch(`http://web.test${target}`, { headers, method, redirect: "manual" }),
        }),
      stderr: () => stderr,
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

const signIn = "/auth/sign-in/email";

layer(WebProdLive, { timeout: 180_000 })("front-door rate limit", (it) => {
  it.effect("refuses the 6th credential POST on a fetch and on a navigation", () =>
    Effect.gen(function* credential() {
      const web = yield* WebProd;
      const ip = "10.0.0.1";

      for (const _ of Array.from({ length: 5 })) {
        const allowed = yield* web.send("POST", signIn, { "x-test-ip": ip });

        expect(allowed.status).not.toBe(429);
      }

      const before = web.stderr().length;

      const navigation = yield* web.send("POST", signIn, {
        accept: "text/html",
        "sec-fetch-mode": "navigate",
        "x-test-ip": ip,
      });

      const fetched = yield* web.send("POST", signIn, {
        accept: "application/json",
        "x-test-ip": ip,
      });

      for (const response of [navigation, fetched]) {
        expect(response.status).toBe(429);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        expect(response.headers.get("retry-after")).toBe("60");

        const problem = yield* Schema.decodeUnknownEffect(RateLimited)(
          yield* Effect.promise(() => response.json()),
        );

        expect(problem.retryAfterSeconds).toBe(60);
      }

      // No log or span: the refusals add no line to the runtime's output. The tracing layer lives
      // in `runtime.ts`, which the 429 branch never reaches, so nothing could emit a span first.
      expect(web.stderr().slice(before).join("\n")).not.toMatch(/ratelimit|span|trace/iu);
    }),
  );

  it.effect("refuses the 101st public GET with Retry-After 10", () =>
    Effect.gen(function* publicClass() {
      const web = yield* WebProd;
      const headers = { "x-test-ip": "10.0.0.2" };

      for (const _ of Array.from({ length: 100 })) {
        const allowed = yield* web.send("GET", "/", headers);

        expect(allowed.status).not.toBe(429);
      }

      const refused = yield* web.send("GET", "/", headers);

      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("10");
    }),
  );

  it.effect("lets a request through when the limiter rejects, logging one error", () =>
    Effect.gen(function* failOpen() {
      const web = yield* WebProd;
      const before = web.stderr().length;
      const response = yield* web.send("POST", signIn, { "x-test-ip": "reject" });

      expect(response.status).not.toBe(429);

      // `structuredLogs` hands `console.error` an object, which workerd prints across lines.
      const output = yield* web.awaitStderr(before, "web.ratelimit.error");

      expect(output.split("message: 'web.ratelimit.error'")).toHaveLength(2);
      expect(output).toContain("level: 'ERROR'");
      expect(output).toContain("annotations: { 'ratelimit.class': 'credential' }");
    }),
  );

  it.effect("skips both limiters when cf-connecting-ip is absent", () =>
    Effect.gen(function* noHeader() {
      const web = yield* WebProd;
      const before = [yield* web.limiterCalls("public"), yield* web.limiterCalls("credential")];

      const response = yield* web.send("POST", signIn, {});

      expect(response.status).not.toBe(429);
      expect([
        yield* web.limiterCalls("public"),
        yield* web.limiterCalls("credential"),
      ]).toStrictEqual(before);
    }),
  );
});
