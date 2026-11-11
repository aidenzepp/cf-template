import { Effect, Predicate, Record, Schema } from "effect";

/**
 * The levels Better Auth passes to `logger.log`; its `success` is delivered as `info`.
 */
type BetterAuthLevel = "debug" | "info" | "warn" | "error";

/**
 * What Better Auth passes after a message: text, plain data or an `Error`.
 */
export type LogArgument = Schema.Json | Error;

/**
 * Starts an effect on the fiber runtime of the execution that built the instance and returns at
 * once, as `Effect.runForkWith(services)` does.
 */
export type Fork = (effect: Effect.Effect<void>) => void;

/**
 * An address whose quoted local part may hold spaces, through the end of its domain.
 */
const QUOTED_LOCAL_PART = /"[^"]*"@\S*/gu;

/**
 * Whitespace runs, kept by `split` so the text rejoins unchanged.
 */
const WHITESPACE_RUNS = /(?<space>\s+)/u;

/**
 * How many levels of an argument are copied before the rest becomes `[truncated]`.
 */
const MAX_DEPTH = 4;

/**
 * The Effect logger that carries each Better Auth level.
 */
const EFFECT_LOGGER = {
  debug: Effect.logDebug,
  error: Effect.logError,
  info: Effect.logInfo,
  warn: Effect.logWarning,
} as const;

/**
 * Whether a value is plain data.
 */
const isJson = Schema.is(Schema.Json);

/**
 * Whether plain data is an array.
 */
const isJsonArray = Schema.is(Schema.Array(Schema.Json));

/**
 * Whether plain data is an object.
 */
const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Replace every whitespace-free run that contains an `@`, whole, so a list, a JSON document or a
 * URL around an address leaves no fragment of it. A run that ends in `@` or starts with `@` also
 * takes the run beside it, which covers an address cut at a space, and a quoted local part is
 * replaced through its closing quote.
 *
 * @param text - A Better Auth message or argument.
 * @returns The text with each such run replaced by `[email]`.
 */
export const redactEmails = (text: string): string => {
  const tokens = text.replaceAll(QUOTED_LOCAL_PART, "[email]").split(WHITESPACE_RUNS);
  const word = (index: number) => (index % 2 === 0 ? (tokens[index] ?? "") : "");

  return tokens
    .map((token, index) =>
      index % 2 === 0 &&
      (token.includes("@") || word(index - 2).endsWith("@") || word(index + 2).startsWith("@"))
        ? "[email]"
        : token,
    )
    .join("");
};

/**
 * The cause an `Error` carries, as a log argument; a cause that is neither plain data nor an
 * `Error` is replaced by a note, and a missing cause by `null`.
 *
 * @param error - The error.
 * @returns The cause.
 */
const causeOf = (error: Error): LogArgument => {
  const { cause } = error;

  if (cause === undefined) {
    return null;
  }

  return Predicate.isError(cause) || isJson(cause) ? cause : "[cause is not loggable]";
};

/**
 * Copy plain data with every string and key redacted, to `MAX_DEPTH` levels.
 *
 * @param value - Plain data.
 * @param depth - How many more levels may be copied.
 * @returns A copy that holds no address.
 */
const redactJson = (value: Schema.Json, depth: number): Schema.Json => {
  if (Predicate.isString(value)) {
    return redactEmails(value);
  }

  if (Predicate.isNull(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return value;
  }

  if (isJsonArray(value)) {
    return depth <= 0 ? "[truncated]" : value.map((item) => redactJson(item, depth - 1));
  }

  if (isJsonRecord(value)) {
    return depth <= 0
      ? "[truncated]"
      : Record.mapEntries(value, (item, key) => [redactEmails(key), redactJson(item, depth - 1)]);
  }

  return value;
};

/**
 * Copy a log argument into plain data with every string redacted. An `Error` keeps its name,
 * message, stack and cause.
 *
 * @param argument - A Better Auth log argument.
 * @param depth - How many more levels may be copied.
 * @returns A copy that holds no address.
 */
const redactArgument = (argument: LogArgument, depth: number): Schema.Json => {
  if (!Predicate.isError(argument)) {
    return redactJson(argument, depth);
  }

  if (depth <= 0) {
    return "[truncated]";
  }

  return {
    cause: redactArgument(causeOf(argument), depth - 1),
    message: redactEmails(argument.message),
    name: argument.name,
    stack: redactEmails(argument.stack ?? ""),
  };
};

/**
 * The Better Auth `logger` option: every message goes through the Effect logger of the execution
 * at the level Better Auth gave it, with every address redacted.
 *
 * Better Auth's own `level` stays at its default of `warn`, so only warnings and errors arrive;
 * this logger keeps the addresses that some of those messages and their arguments carry out of the
 * log. The message and its string arguments become the line's text. Every other argument becomes
 * the `args` annotation as redacted plain data, and an `Error` also adds its message to the text.
 *
 * @param fork - Starts a log effect under the services the instance was built with.
 * @returns The `logger` option.
 */
export const betterAuthLogger = (fork: Fork) => ({
  log: (level: BetterAuthLevel, message: string, ...args: ReadonlyArray<LogArgument>) => {
    const text = redactEmails(
      [
        message,
        ...args.flatMap((arg) => {
          if (Predicate.isString(arg)) {
            return [arg];
          }

          return Predicate.isError(arg) ? [arg.message] : [];
        }),
      ].join(" "),
    );

    const structured = args
      .filter((arg) => !Predicate.isString(arg))
      .map((arg) => redactArgument(arg, MAX_DEPTH));

    const line = EFFECT_LOGGER[level](text);

    fork(structured.length === 0 ? line : Effect.annotateLogs(line, "args", structured));
  },
});
