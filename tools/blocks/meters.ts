import { Effect, Schema } from "effect";

/**
 * The meters a block may bill, the only tokens a `Meter:` list accepts.
 */
const meters = [
  "Workers requests",
  "CPU ms",
  "KV",
  "D1",
  "R2",
  "Queues",
  "Durable Objects",
  "Workflows",
  "Secrets Store",
] as const;

/**
 * What a `Meter:` line declares: no meter, a list of meters, or an unknown meter with its reason.
 */
export type Meter =
  | { readonly kind: "list"; readonly meters: ReadonlyArray<string> }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Raised when the first line of a block README is not a valid `Meter:` line.
 */
export class MeterError extends Schema.TaggedError<MeterError>()("MeterError", {
  message: Schema.String,
}) {}

/**
 * Reads the `Meter:` line, the first line of a block package's `README.md`: exactly one of
 * `Meter: none`, `Meter: <comma-separated meters>` with every token from `meters`, or
 * `Meter: UNKNOWN (<reason>)`. Anything else fails.
 */
export const parseMeter = (readme: string): Effect.Effect<Meter, MeterError> =>
  Effect.suspend(() => {
    const [first = ""] = readme.split("\n");
    const value = /^Meter: (?<value>.+)$/u.exec(first)?.groups?.value;
    const reason = /^UNKNOWN \((?<reason>[^()]+)\)$/u.exec(value ?? "")?.groups?.reason;
    const tokens = (value ?? "").split(", ");

    if (value === "none") {
      return Effect.succeed<Meter>({ kind: "none" });
    }

    if (reason !== undefined) {
      return Effect.succeed<Meter>({ kind: "unknown", reason });
    }

    return value !== undefined && tokens.every((token) => meters.some((known) => known === token))
      ? Effect.succeed<Meter>({ kind: "list", meters: tokens })
      : Effect.fail(
          new MeterError({
            message: `the first line is not a valid Meter: line; write Meter: none, Meter: <meters from ${meters.join(", ")}>, or Meter: UNKNOWN (<reason>)`,
          }),
        );
  });
