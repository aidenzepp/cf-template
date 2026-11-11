import { Schema } from "effect";

/**
 * The compatibility settings every Worker receives: one date and the flags that become default
 * later, so the date bump check can find a flag that is already safe to drop.
 */
export const Compat = Schema.Struct({
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  flags: Schema.Array(
    Schema.Struct({
      defaultOn: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
      name: Schema.String,
    }),
  ),
});

/**
 * The compatibility settings of every Worker.
 */
export const compat: typeof Compat.Type = {
  date: "2026-10-26",
  flags: [{ defaultOn: "2026-11-17", name: "enable_request_signal" }],
};
