import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { OpenApi } from "effect/http-api";
import { AUTH_BASE_PATH } from "@workspace/auth/contract";
import { Api } from "@workspace/contract/api/api";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { ProblemAdapter } from "../problem-details.ts";
import { ApiDocsRoutes } from "./routes.ts";

/**
 * The origin the tests call `api` on.
 */
const ORIGIN = "https://app.example.test";

/**
 * One answer of the router: its status, content type and body text.
 */
interface Answer {
  readonly body: string;
  readonly status: number;
  readonly type: string;
}

/**
 * Build the documentation routes under the problem adapter, with `DOCS_ENABLED` set to `docs`
 * in the config provider, and return a function that calls them.
 *
 * @param docs - The raw `DOCS_ENABLED` value, or `undefined` to leave it unset.
 * @returns A scoped effect of the function that answers a path.
 */
const serve = (docs: string | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        ApiDocsRoutes.pipe(
          Layer.merge(ProblemAdapter),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown(docs === undefined ? {} : { DOCS_ENABLED: docs }),
            ),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(
    Effect.map(
      ({ handler }) =>
        (url: string): Effect.Effect<Answer> =>
          Effect.gen(function* answer() {
            const response = yield* Effect.promise(() => handler(new Request(url)));

            return {
              body: yield* Effect.promise(() => response.text()),
              status: response.status,
              type: response.headers.get("content-type") ?? "",
            };
          }),
    ),
  );

/**
 * The target of every Markdown link in a text.
 *
 * @param text - The Markdown text.
 * @returns The URLs, in order.
 */
const linksOf = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/\]\((?<url>[^)]+)\)/gu)].map((match) => match.groups?.url ?? "");

describe("the documentation routes with DOCS_ENABLED on", () => {
  it.effect("serve a document equal to OpenApi.fromApi(Api)", () =>
    Effect.gen(function* document() {
      const get = yield* serve("true");
      const answer = yield* get(`${ORIGIN}${OPENAPI_PATH}`);

      assert.strictEqual(answer.status, 200);
      assert.include(answer.type, "application/json");
      assert.strictEqual(answer.body, JSON.stringify(OpenApi.fromApi(Api)));
    }).pipe(Effect.scoped),
  );

  it.effect("keep the auth base path out of the served document", () =>
    Effect.gen(function* noAuth() {
      const get = yield* serve("true");
      const answer = yield* get(`${ORIGIN}${OPENAPI_PATH}`);

      const served = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) }),
        ),
      )(answer.body);

      const paths = Object.keys(served.paths);

      assert.isAbove(paths.length, 0);
      assert.deepStrictEqual(
        paths.filter((path) => path.startsWith(AUTH_BASE_PATH)),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("serve the Scalar page with its script inline and no external script", () =>
    Effect.gen(function* page() {
      const get = yield* serve("true");
      const answer = yield* get(`${ORIGIN}${DOCS_PATH}`);

      assert.strictEqual(answer.status, 200);
      assert.include(answer.type, "text/html");
      assert.include(answer.body, "createApiReference");
      assert.notMatch(answer.body, /<script[^>]*\ssrc=/u);
      assert.match(answer.body, /withDefaultFonts(?:&quot;|")?:\s*false/u);
    }).pipe(Effect.scoped),
  );

  it.effect("serve llms.txt whose links all resolve on the request origin", () =>
    Effect.gen(function* llms() {
      const get = yield* serve("true");
      const answer = yield* get(`${ORIGIN}${LLMS_PATH}`);
      const links = linksOf(answer.body);

      assert.strictEqual(answer.status, 200);
      assert.include(answer.type, "text/plain");
      assert.deepStrictEqual(links, [`${ORIGIN}${OPENAPI_PATH}`, `${ORIGIN}${DOCS_PATH}`]);

      for (const link of links) {
        assert.strictEqual((yield* get(link)).status, 200);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("list in llms.txt every operation of the document", () =>
    Effect.gen(function* operations() {
      const get = yield* serve("true");
      const answer = yield* get(`${ORIGIN}${LLMS_PATH}`);

      const listed = Object.entries(OpenApi.fromApi(Api).paths).flatMap(([path, item]) =>
        (["get", "post", "put", "patch", "delete"] as const).flatMap((method) => {
          const operation = item[method];

          return operation === undefined
            ? []
            : [`- \`${method.toUpperCase()} ${path}\`: ${operation.operationId}`];
        }),
      );

      assert.isAbove(listed.length, 0);

      for (const line of listed) {
        assert.include(answer.body, line);
      }
    }).pipe(Effect.scoped),
  );
});

describe("the documentation routes with DOCS_ENABLED off", () => {
  it.effect.each([OPENAPI_PATH, DOCS_PATH, LLMS_PATH])(
    "answer %s as an unrouted path does",
    (path) =>
      Effect.gen(function* off() {
        const get = yield* serve("false");
        const answer = yield* get(`${ORIGIN}${path}`);
        const unrouted = yield* get(`${ORIGIN}/api/does-not-exist`);

        assert.strictEqual(answer.status, 404);
        assert.deepStrictEqual(answer, unrouted);
        assert.include(answer.type, "application/problem+json");
      }).pipe(Effect.scoped),
  );

  it.effect("answer 404 when nothing sets the knob, whose default is off", () =>
    Effect.gen(function* unset() {
      const get = yield* serve(undefined);

      for (const path of [OPENAPI_PATH, DOCS_PATH, LLMS_PATH]) {
        assert.strictEqual((yield* get(`${ORIGIN}${path}`)).status, 404);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("answer 404 when only the retired API_DOCS_ENABLED is set to true", () =>
    Effect.gen(function* retired() {
      const web = HttpRouter.toWebHandler(
        ApiDocsRoutes.pipe(
          Layer.merge(ProblemAdapter),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ API_DOCS_ENABLED: "true" })),
          ),
        ),
        { disableLogger: true },
      );

      for (const path of [OPENAPI_PATH, DOCS_PATH, LLMS_PATH]) {
        const response = yield* Effect.promise(() => web.handler(new Request(`${ORIGIN}${path}`)));

        assert.strictEqual(response.status, 404);
      }
      yield* Effect.promise(web.dispose);
    }),
  );
});
