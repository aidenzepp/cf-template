import { Config, Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * Whether `api` serves its OpenAPI document, the Scalar reference page and `llms.txt`. While it is
 * `false` all three answer 404, as an unrouted path does. Only `api` reads it; `infra/stages.ts`
 * turns it on for every stage kind except `prod`. On a stage where {@link ApiDocsLiveRead} is off,
 * the deploy-time value is the only one read.
 */
export const ApiDocsEnabledKnob = Knob.make(
  "API_DOCS_ENABLED",
  Schema.Boolean.annotate({
    default: false,
    description: "Whether api serves /api/openapi.json, /api/docs and /llms.txt or answers 404.",
  }),
);

/**
 * Whether `api` may read `API_DOCS_ENABLED` from the live source. `infra/src/api.ts` binds it
 * `false` on `prod` only, from the stage the deployer already holds, because `api` is handed no
 * stage. Off, the deploy-time value is final: the live tier is never read and, while that value is
 * `false`, the documentation routes are not built. A binding that is absent counts as off.
 */
export const ApiDocsLiveRead = Config.Boolean("API_DOCS_LIVE_READ").pipe(Config.withDefault(false));
