import { Schema } from "effect";
import { Knob } from "./knob.ts";

/**
 * The Cloudflare Workers plan of the deploying account, read as `CLOUDFLARE_PLAN` and defaulting
 * to `paid`.
 *
 * The deploy preflight and the preview pre-step read this one knob.
 */
export const CloudflarePlanKnob = Knob.make(
  "CLOUDFLARE_PLAN",
  Schema.Literals(["free", "paid"]).annotate({
    default: "paid",
    description: "The Cloudflare Workers plan of the deploying account.",
  }),
);
