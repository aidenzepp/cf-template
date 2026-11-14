import { Config, Option, Schema, SchemaTransformation } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * The requests a Workers Paid plan includes per billing period.
 */
const INCLUDED_REQUESTS = 10_000_000;

/**
 * The CPU time, in ms, a Workers Paid plan includes per billing period.
 */
const INCLUDED_CPU_MS = 30_000_000;

/**
 * The egress, in bytes, a billing period includes before the guard counts it spent: `50 x 2^30`.
 */
const INCLUDED_BYTES = 50 * 2 ** 30;

/**
 * The number of `1 h` windows in a `30 d` billing period.
 */
const HOURLY_WINDOWS = 720;

/**
 * A measured per-request cost: a finite number above `0`.
 */
const positiveMeasure = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));

/**
 * The schema of a measured input that has no default: an absent key is `Option.none()`, a supplied
 * value must be a positive finite number, and the string form of `none` is the empty string.
 *
 * @param description - What the knob measures.
 * @returns The annotated schema `Knob.make` takes.
 */
const measuredInput = (description: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Option(positiveMeasure),
      SchemaTransformation.transform({
        decode: (text: string) =>
          text.trim() === "" ? Option.none<number>() : Option.some(Number(text)),
        encode: (value: Option.Option<number>) =>
          Option.match(value, { onNone: () => "", onSome: String }),
      }),
    ),
  ).annotate({ default: Option.none<number>(), description });

/**
 * The CPU one request costs, in ms, read as `CPU_MS_PER_REQUEST`. It has no default: the value is
 * measured on a `test-<slug>` stage, and until it is set the budget guard declares no alert.
 */
export const CpuMsPerRequestKnob = Knob.make(
  "CPU_MS_PER_REQUEST",
  measuredInput("Measured CPU per request, in ms; unset until a test stage measures it."),
);

/**
 * The bytes one request moves, read as `BYTES_PER_REQUEST`. It has no default: the value is
 * measured on a `test-<slug>` stage, and until it is set the budget guard declares no alert.
 */
export const BytesPerRequestKnob = Knob.make(
  "BYTES_PER_REQUEST",
  measuredInput("Measured bytes per request; unset until a test stage measures it."),
);

/**
 * How many times the project's hourly share the guard tolerates, read as `GUARD_MULTIPLE`.
 */
export const GuardMultipleKnob = Knob.make(
  "GUARD_MULTIPLE",
  positiveMeasure.annotate({
    default: 10,
    description:
      "Multiple of the project's hourly allowance share at which the budget guard fires.",
  }),
);

/**
 * The deploy-time value of the three budget-guard knobs, read once through `Config`.
 */
export const budgetGuardKnobs = Config.all({
  bytesPerRequest: BytesPerRequestKnob.config,
  cpuMsPerRequest: CpuMsPerRequestKnob.config,
  multiple: GuardMultipleKnob.config,
});

/**
 * The request count per `1 h` at which the budget guard fires: `multiple` times `share` times the
 * requests the tightest included allowance affords over `720 h`, per hour.
 *
 * The tightest allowance is the least of the included requests, the included CPU ms over
 * `cpuMsPerRequest`, and the included bytes over `bytesPerRequest`.
 *
 * @param inputs - The measured inputs and the two multipliers.
 * @param inputs.multiple - The value of `GUARD_MULTIPLE`.
 * @param inputs.share - The value of `ALLOWANCE_SHARE`.
 * @param inputs.cpuMsPerRequest - The value of `CPU_MS_PER_REQUEST`.
 * @param inputs.bytesPerRequest - The value of `BYTES_PER_REQUEST`.
 * @returns The requests per `1 h` above which the alert fires.
 */
export const guardPerHour = (inputs: {
  readonly multiple: number;
  readonly share: number;
  readonly cpuMsPerRequest: number;
  readonly bytesPerRequest: number;
}): number =>
  (inputs.multiple *
    inputs.share *
    Math.min(
      INCLUDED_REQUESTS,
      INCLUDED_CPU_MS / inputs.cpuMsPerRequest,
      INCLUDED_BYTES / inputs.bytesPerRequest,
    )) /
  HOURLY_WINDOWS;
