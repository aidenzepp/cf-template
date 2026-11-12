import { Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * Whether `api` serves its OpenAPI document, the Scalar reference page and `llms.txt`. While it is
 * `false` all three answer 404, as an unrouted path does. Only `api` reads it; `infra/stages.ts`
 * turns it on for every stage kind except `prod`.
 */
export const ApiDocsEnabledKnob = Knob.make(
  "API_DOCS_ENABLED",
  Schema.Boolean.annotate({
    default: false,
    description: "Whether api serves /api/openapi.json, /api/docs and /llms.txt or answers 404.",
  }),
);
