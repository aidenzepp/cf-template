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
 * The `observability` prop of `api` and `auth`: Alchemy's default logs, kept because an explicit
 * prop replaces the default, and Workers Issues on. The traces come from `Cloudflare.Telemetry`.
 */
export const issuesObservability = {
  enabled: true,
  issues: { enabled: true },
  logs: { enabled: true, invocationLogs: true },
} as const;

/**
 * The `observability` prop of `web`, which has no Effect layer of its own: the default logs, Issues
 * on, and traces at the stage's head sampling rate.
 *
 * @param stage - The decoded stage.
 * @returns The prop for `Cloudflare.Website.Vite`.
 */
export const webObservability = (stage: StageName) =>
  ({
    ...issuesObservability,
    traces: { enabled: true, headSamplingRate: headSamplingRate(stage) },
  }) as const;

/**
 * The options the Worker-side tracing layer takes for a stage.
 *
 * @param stage - The decoded stage.
 * @returns A plain object holding the stage's head sampling rate.
 */
export const telemetryOptions = (stage: StageName) => ({
  headSamplingRate: headSamplingRate(stage),
});
