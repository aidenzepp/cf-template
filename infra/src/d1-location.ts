import { Effect, Option, Schema } from "effect";
import { Knob } from "@workspace/config/knob";

/**
 * The primary location hint of the `prod` D1 databases, read as `D1_PROD_LOCATION_HINT`.
 *
 * The empty string is the unset value: it lets Cloudflare place the databases. The hint applies
 * only when a database is created, so a `prod` deploy that changes it for an existing database is
 * refused by `guardLocationHints`.
 *
 * The knob stays a leaf schema because `Schema.Option` decodes nothing from a `Config` string and
 * would silently ignore a supplied hint; {@link d1LocationHint} turns the unset value into `none`.
 */
export const D1LocationHintKnob = Knob.make(
  "D1_PROD_LOCATION_HINT",
  Schema.Literals(["", "wnam", "enam", "weur", "eeur", "apac", "oc"]).annotate({
    default: "",
    description:
      "Primary location hint for the prod D1 databases; unset lets Cloudflare place them.",
  }),
);

/**
 * Read the knob as an `Option` that is `none` when the hint is unset.
 *
 * @returns The hint, or the failure of an invalid supplied value.
 */
export const d1LocationHint = D1LocationHintKnob.config.pipe(
  Effect.map((hint) => (hint === "" ? Option.none() : Option.some(hint))),
);
