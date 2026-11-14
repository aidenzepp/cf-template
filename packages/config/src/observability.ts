import { Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * Head sampling rate for Workers traces, from `0` to `1` inclusive, read as `HEAD_SAMPLING_RATE`.
 */
export const HeadSamplingRateKnob = Knob.make(
  "HEAD_SAMPLING_RATE",
  Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 })).annotate({
    default: 1,
    description: "Head sampling rate for Workers traces; applied from Worker metadata at deploy.",
  }),
);
