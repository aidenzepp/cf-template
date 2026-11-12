import { ApiDocsEnabledKnob } from "../../packages/config/src/api-docs.ts";
import { LogLevelKnob } from "../../packages/config/src/log-level.ts";
// block:notes start
import { ExampleFeatureKnob } from "../../apps/api/src/notes/knob.ts";
// block:notes end

/**
 * The knobs an operator may set live: the three the template ships, `LOG_LEVEL`,
 * `API_DOCS_ENABLED` and `EXAMPLE_FEATURE_ENABLED`. An attach file (form 4): a block that adds a
 * live knob adds it here. `knob status` reports a stored key absent from this list as `ORPHAN`.
 * `API_DOCS_ENABLED` is live on every stage but `prod`, which reads its deploy-time value only.
 */
export const liveKnobs = [
  LogLevelKnob,
  ApiDocsEnabledKnob,
  // block:notes start
  ExampleFeatureKnob,
  // block:notes end
] as const;
