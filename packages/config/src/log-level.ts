import { LogLevel, Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * The minimum level a Worker logs at, read as `LOG_LEVEL` and defaulting to `Info`.
 */
export const LogLevelKnob = Knob.make(
  "LOG_LEVEL",
  Schema.Literals(LogLevel.values).annotate({
    default: "Info",
    description: "Minimum level a Worker logs at.",
  }),
);
