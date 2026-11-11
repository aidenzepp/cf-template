import { Stages, kindOf } from "../stages.ts";
import type { StageName } from "../stages.ts";

/**
 * The head sampling rate of a stage's Workers traces.
 *
 * @param stage - The decoded stage.
 * @returns The `HEAD_SAMPLING_RATE` of the stage's kind in `Stages`, from `0` to `1`.
 */
export const headSamplingRate = (stage: StageName): number =>
  Stages[kindOf(stage)].HEAD_SAMPLING_RATE;

/**
 * The options the Worker-side tracing layer takes for a stage.
 *
 * @param stage - The decoded stage.
 * @returns A plain object holding the stage's head sampling rate.
 */
export const telemetryOptions = (stage: StageName) => ({
  headSamplingRate: headSamplingRate(stage),
});
