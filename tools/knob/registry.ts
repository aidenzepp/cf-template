import { DocsEnabledKnob } from "../../packages/config/src/docs.ts";
import { LogLevelKnob } from "../../packages/config/src/log-level.ts";
// block:notes start
import { ExampleFeatureKnob } from "../../apps/api/src/notes/knob.ts";
// block:notes end

/**
 * The knobs an operator may set live: the three the template ships, `LOG_LEVEL`,
 * `DOCS_ENABLED` and `EXAMPLE_FEATURE_ENABLED`. An attach file (form 4): a block that adds a
 * live knob adds it here. `knob status` reports a stored key absent from this list as `ORPHAN`.
 * `DOCS_ENABLED` is live on every stage but `prod`, which reads its deploy-time value only.
 */
export const liveKnobs = [
  LogLevelKnob,
  DocsEnabledKnob,
  // block:notes start
  ExampleFeatureKnob,
  // block:notes end
] as const;
