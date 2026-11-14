import type { Config } from "effect";
import { Effect, Option } from "effect";
import { budgetGuardKnobs, guardPerHour } from "./knobs.ts";
import { AllowanceShareKnob } from "@workspace/config/observability";

/**
 * The request count per `1 h` at which the budget guard's alert fires, read from the deploy-time
 * knobs `CPU_MS_PER_REQUEST`, `BYTES_PER_REQUEST`, `GUARD_MULTIPLE` and `ALLOWANCE_SHARE`.
 *
 * There is no placeholder: while either measured input is unset the result is `Option.none()` and
 * the effect logs `budget-guard: alert not declared (CPU_MS_PER_REQUEST or BYTES_PER_REQUEST
 * unset)` once, so the caller declares no alert resource.
 *
 * @returns The threshold, or none when a measured input is unset. An invalid supplied value fails
 *   through the `Config` error channel.
 */
export const guardThreshold = Effect.gen(function* guardThresholdEffect() {
  const knobs = yield* budgetGuardKnobs;
  const share = yield* AllowanceShareKnob.config;
  const inputs = Option.all({ bytes: knobs.bytesPerRequest, cpu: knobs.cpuMsPerRequest });

  if (Option.isNone(inputs)) {
    yield* Effect.logInfo(
      "budget-guard: alert not declared (CPU_MS_PER_REQUEST or BYTES_PER_REQUEST unset)",
    );

    return Option.none<number>();
  }

  return Option.some(
    guardPerHour({
      bytesPerRequest: inputs.value.bytes,
      cpuMsPerRequest: inputs.value.cpu,
      multiple: knobs.multiple,
      share,
    }),
  );
}) satisfies Effect.Effect<Option.Option<number>, Config.ConfigError>;
