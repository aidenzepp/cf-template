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
 * Whether a stage records Workers traces and Workers Issues, the one place both are decided. The
 * `test` kind (`test-ci`, `test-<slug>`) does not: the account holder ruled that test stages carry
 * no alerts or anything else superfluous, and the approved list (2026-11-14) drops their traces and
 * Issues. Workers Logs stay on for every stage.
 *
 * @param stage - The decoded stage.
 * @returns `false` for the `test` kind, `true` for `prod`, `staging` and `local`.
 */
export const recordsDiagnostics = (stage: StageName): boolean => kindOf(stage) !== "test";

/**
 * The `observability` prop of `api` and `auth`: Alchemy's default logs, kept because an explicit
 * prop replaces the default, and Workers Issues where {@link recordsDiagnostics} allows them. The
 * traces come from `Cloudflare.Telemetry`.
 *
 * @param stage - The decoded stage.
 * @returns The prop for `Cloudflare.Worker`.
 */
export const issuesObservability = (stage: StageName) =>
  ({
    enabled: true,
    issues: { enabled: recordsDiagnostics(stage) },
    logs: { enabled: true, invocationLogs: true },
  }) as const;

/**
 * The `observability` prop of `web`, which has no Effect layer of its own: the default logs, and
 * Issues and traces at the stage's head sampling rate where {@link recordsDiagnostics} allows them.
 *
 * @param stage - The decoded stage.
 * @returns The prop for `Cloudflare.Website.Vite`.
 */
export const webObservability = (stage: StageName) =>
  ({
    ...issuesObservability(stage),
    traces: { enabled: recordsDiagnostics(stage), headSamplingRate: headSamplingRate(stage) },
  }) as const;

/**
 * The options the Worker-side tracing layer takes for a stage. The layer stays bound on every
 * stage, so the Workers' Effect spans keep a tracer, but it declares the Worker's traces off where
 * {@link recordsDiagnostics} does not allow them.
 *
 * @param stage - The decoded stage.
 * @returns Whether traces are on, and the stage's head sampling rate.
 */
export const telemetryOptions = (stage: StageName) => ({
  enabled: recordsDiagnostics(stage),
  headSamplingRate: headSamplingRate(stage),
});
