import { Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * Head sampling rate for Workers traces, from `0` to `1` inclusive, read as `HEAD_SAMPLING_RATE`.
 */
export const HeadSamplingRateKnob = Knob.make(
  "HEAD_SAMPLING_RATE",
  Schema.Number.check(Schema.isBetween({ maximum: 1, minimum: 0 })).annotate({
    default: 1,
    description: "Head sampling rate for Workers traces; applied from Worker metadata at deploy.",
  }),
);

/**
 * The share of the account's Paid allowances this project may use, from `0` to `1` inclusive, read
 * as `ALLOWANCE_SHARE`.
 */
export const AllowanceShareKnob = Knob.make(
  "ALLOWANCE_SHARE",
  Schema.Number.check(Schema.isBetween({ maximum: 1, minimum: 0 })).annotate({
    default: 0.5,
    description: "Placeholder share of the account's Paid allowances this project may use.",
  }),
);

/**
 * The fraction of the project's share whose hourly pace fires the volume alert, from `0` to `1`
 * inclusive, read as `ALERT_FRACTION`.
 */
export const AlertFractionKnob = Knob.make(
  "ALERT_FRACTION",
  Schema.Number.check(Schema.isBetween({ maximum: 1, minimum: 0 })).annotate({
    default: 0.5,
    description: "Fraction of the project's share whose hourly pace fires the volume alert.",
  }),
);
