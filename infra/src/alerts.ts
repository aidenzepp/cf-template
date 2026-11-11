import { Effect } from "effect";
import { Workers, workerName } from "../stages.ts";
import type { StageName, WorkerNameTooLongError } from "../stages.ts";

/**
 * The requests a Workers Paid plan includes per billing period.
 */
const INCLUDED_REQUESTS = 10_000_000;

/**
 * The number of `1 h` windows in a `30 d` billing period.
 */
const HOURLY_WINDOWS = 720;

/**
 * The requests per `1 h` window above which the volume alert fires.
 *
 * @param share - The `ALLOWANCE_SHARE` knob value.
 * @param fraction - The `ALERT_FRACTION` knob value.
 * @returns The included requests times `share` times `fraction`, per `1 h` window, rounded down.
 */
export const volumeAlertThreshold = (share: number, fraction: number): number =>
  Math.floor((INCLUDED_REQUESTS * share * fraction) / HOURLY_WINDOWS);

/**
 * The Worker names the volume alert counts: each entry of `Workers` in order, then the state
 * store `<stack>-state`.
 *
 * It returns an effect because {@link workerName} fails on a name past the Worker name limit.
 *
 * @param stack - The stack name.
 * @param stage - The decoded stage.
 * @returns The Worker names, or the {@link WorkerNameTooLongError} of the first name that is too
 *   long.
 */
export const volumeAlertWorkers = (
  stack: string,
  stage: StageName,
): Effect.Effect<readonly string[], WorkerNameTooLongError> =>
  Effect.all(Workers.map((worker) => workerName({ stack, stage, worker }))).pipe(
    Effect.map((names) => [...names, `${stack}-state`]),
  );
