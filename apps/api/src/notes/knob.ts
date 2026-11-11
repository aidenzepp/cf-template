import { Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * Whether the example notes feature is on. While it is off, `api` answers every notes request of a
 * signed-in caller with 404 `NotesUnavailable`. Only `api` reads it.
 */
export const ExampleFeatureKnob = Knob.make(
  "EXAMPLE_FEATURE_ENABLED",
  Schema.Boolean.annotate({
    default: false,
    description: "Whether the example notes endpoints answer or return 404.",
  }),
);
