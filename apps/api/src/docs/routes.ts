import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerResponse, Url } from "effect/http";
import { HttpApiScalar, OpenApi } from "effect/http-api";
import { ApiDocsEnabledKnob, ApiDocsLiveRead } from "@workspace/config/api-docs";
import { LiveKnobs } from "@workspace/config/knob";
import { Api } from "@workspace/contract/api/api";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { llmsText } from "./llms.ts";

/**
 * The route-scoped gate of the three documentation routes: it answers a bare 404 while `enabled`
 * yields `false`. The adapter of `problem-details.ts` turns that 404 into the same problem body an
 * unrouted path gets, so a switched-off route is indistinguishable from one that does not exist.
 *
 * @param enabled - Whether the routes answer, read on every request.
 * @returns The router middleware.
 */
const docsGate = (enabled: Effect.Effect<boolean>) =>
  HttpRouter.middleware(
    Effect.succeed(<E, R>(httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      enabled.pipe(
        Effect.flatMap((on) =>
          on ? httpEffect : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ),
      ),
    ),
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
 * The Scalar reference page, from `HttpApiScalar.layer`, which inlines Scalar's script and the
 * document into the HTML. Nothing loads from a CDN, so the page needs no third-party origin;
 * `withDefaultFonts: false` stops Scalar fetching its fonts from `fonts.scalar.com`. The script is
 * a dynamic import, read only when this layer is built.
 */
export const ScalarPage = HttpApiScalar.layer(Api, {
  path: DOCS_PATH,
  scalar: { withDefaultFonts: false },
});

/**
 * The routes that document `Api`, behind `API_DOCS_ENABLED`: the OpenAPI document, the Scalar
 * reference page and `llms.txt`.
 *
 * Where `API_DOCS_LIVE_READ` is on, the gate reads the knob through the `LiveKnobs` port on every
 * request (one cached key read; the KV adapter caches each key for 30 seconds), with the
 * deploy-time value as the fallback. Where it is off, which `infra` sets on `prod` alone, the
 * deploy-time value is final: a live value is never read, and when that value is `false` no route
 * and no Scalar layer is built, so the page's script is never imported and every path is unrouted.
 */
export const ApiDocsRoutes = Layer.unwrap(
  Effect.gen(function* buildDocsRoutes() {
    const live = yield* ApiDocsLiveRead;
    const deployed = yield* ApiDocsEnabledKnob.config;

    if (!live && !deployed) {
      return Layer.empty;
    }

    const enabled = live
      ? yield* (yield* LiveKnobs).bind(ApiDocsEnabledKnob)
      : Effect.succeed(deployed);

    return Layer.mergeAll(DocumentRoutes, ScalarPage).pipe(Layer.provide(docsGate(enabled).layer));
  }),
);
