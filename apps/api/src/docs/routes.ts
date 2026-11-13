import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerResponse, Url } from "effect/http";
import { HttpApiMiddleware, HttpApiScalar, OpenApi } from "effect/http-api";
import * as DomainHttp from "@alchemy.run/domain/Http";
import { DocsEnabledKnob, DocsLiveRead } from "@workspace/config/docs";
import { LiveKnobs } from "@workspace/config/knob";
import { Api } from "@workspace/contract/api/api";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { NotebookApi } from "../notes/notebook.api.ts";
import { llmsText } from "./llms.ts";

/**
 * The Notebook Api published as a plain HTTP group: one `POST /<Command>` per command, built by
 * `toHttpApi` from the Domain Api, so the model is the one source of its paths and errors.
 */
export const NotebookHttp = DomainHttp.toHttpApi(NotebookApi);

/**
 * The Notebook group as the Worker hosts it: under `/api`, wrapped in `ProblemDetails` like the
 * contract's groups, so a payload that fails to decode answers the same 400 problem. Each rejection
 * keeps the status its schema declares; the global problem adapter turns its body into a problem
 * whose `type` names it.
 */
export const NotebookGroup = NotebookHttp.group
  .prefix("/api")
  .middleware(HttpApiMiddleware.ProblemDetails);

/**
 * What the `api` Worker serves and documents: the contract's `Api` with {@link NotebookGroup}
 * merged into it.
 */
export const ServedApi = Api.add(NotebookGroup);

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
 * `OpenApi.fromApi(ServedApi)` builds when the layer is built. Nothing is checked in: the document
 * and the text follow the contract and the Notebook group.
 */
const DocumentRoutes = HttpRouter.use((router) =>
  Effect.gen(function* addDocumentRoutes() {
    const document = OpenApi.fromApi(ServedApi);

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
export const ScalarPage = HttpApiScalar.layer(ServedApi, {
  path: DOCS_PATH,
  scalar: { withDefaultFonts: false },
});

/**
 * The routes that document {@link ServedApi}, behind `DOCS_ENABLED`: the OpenAPI document, the
 * Scalar reference page and `llms.txt`.
 *
 * Where `DOCS_LIVE_READ` is on, the gate reads the knob through the `LiveKnobs` port on every
 * request (one cached key read; the KV adapter caches each key for 30 seconds), with the
 * deploy-time value as the fallback. Where it is off, which `infra` sets on `prod` alone, the
 * deploy-time value is final: a live value is never read, and when that value is `false` no route
 * and no Scalar layer is built, so the page's script is never imported and every path is unrouted.
 */
export const ApiDocsRoutes = Layer.unwrap(
  Effect.gen(function* buildDocsRoutes() {
    const live = yield* DocsLiveRead;
    const deployed = yield* DocsEnabledKnob.config;

    if (!live && !deployed) {
      return Layer.empty;
    }

    const enabled = live
      ? yield* (yield* LiveKnobs).bind(DocsEnabledKnob)
      : Effect.succeed(deployed);

    return Layer.mergeAll(DocumentRoutes, ScalarPage).pipe(Layer.provide(docsGate(enabled).layer));
  }),
);
