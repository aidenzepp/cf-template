import { LogLevelKnob } from "../../packages/config/src/log-level.ts";
// block:notes start
import { ExampleFeatureKnob } from "../../apps/api/src/notes/knob.ts";
// block:notes end

/**
 * The knobs an operator may set live: exactly the two the template ships, `LOG_LEVEL` and
 * `EXAMPLE_FEATURE_ENABLED`. An attach file (form 4): a block that adds a live knob adds it here.
 * `knob status` reports a stored key absent from this list as `ORPHAN`.
 */
export const liveKnobs = [
  LogLevelKnob,
  // block:notes start
  ExampleFeatureKnob,
  // block:notes end
] as const;
