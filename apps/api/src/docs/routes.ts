import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerResponse, Url } from "effect/http";
import { HttpApiScalar, OpenApi } from "effect/http-api";
import { ApiDocsEnabledKnob } from "@workspace/config/api-docs";
import { LiveKnobs } from "@workspace/config/knob";
import { Api } from "@workspace/contract/api/api";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { llmsText } from "./llms.ts";

/**
 * The route-scoped gate of the three documentation routes: it reads `API_DOCS_ENABLED` through the
 * `LiveKnobs` port on every request and answers a bare 404 while the knob is `false`. The adapter
 * of `problem-details.ts` turns that 404 into the same problem body an unrouted path gets, so a
 * switched-off route is indistinguishable from one that does not exist.
 *
 * A live read is one cached key read per request (the KV adapter caches each key for 30 seconds);
 * the tier (b) value the stage binds is the fallback.
 */
const DocsGate = HttpRouter.middleware(
  Effect.gen(function* buildGate() {
    const knobs = yield* LiveKnobs;
    const enabled = yield* knobs.bind(ApiDocsEnabledKnob);

    return <E, R>(httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      enabled.pipe(
        Effect.flatMap((on) =>
          on ? httpEffect : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ),
      );
  }),
);

/**
 * `GET /api/openapi.json` and `GET /llms.txt`, both answered from the one document
 * `OpenApi.fromApi(Api)` builds when the layer is built. Nothing is checked in: the document and
 * the text follow the contract.
 */
const DocumentRoutes = HttpRouter.use((router) =>
  Effect.gen(function* addDocumentRoutes() {
    const document = OpenApi.fromApi(Api);

    yield* router.add("GET", OPENAPI_PATH, HttpServerResponse.jsonUnsafe(document));

    yield* router.add("GET", LLMS_PATH, (request) =>
      Effect.succeed(
        HttpServerResponse.text(
          llmsText(
            Result.match(Url.fromString(request.originalUrl), {
              onFailure: () => "",
              onSuccess: (url) => url.origin,
            }),
            document,
          ),
          { contentType: "text/plain; charset=utf-8" },
        ),
      ),
    );
  }),
);

/**
 * The routes that document `Api`, behind `API_DOCS_ENABLED`: the OpenAPI document, the Scalar
 * reference page and `llms.txt`.
 *
 * The page comes from `HttpApiScalar.layer`, which inlines Scalar's script and the document into
 * the HTML. Nothing loads from a CDN, so the page needs no third-party origin; `withDefaultFonts:
 * false` stops Scalar fetching its fonts from `fonts.scalar.com`. The script is a dynamic import,
 * read only when this layer is built.
 */
export const ApiDocsRoutes = Layer.mergeAll(
  DocumentRoutes,
  HttpApiScalar.layer(Api, { path: DOCS_PATH, scalar: { withDefaultFonts: false } }),
).pipe(Layer.provide(DocsGate.layer));
