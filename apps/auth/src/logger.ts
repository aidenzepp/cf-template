import { Effect, Option, Predicate } from "effect";
import type { Schema } from "effect";

/**
 * The levels Better Auth passes to `logger.log`; its `success` is delivered as `info`.
 */
type BetterAuthLevel = "debug" | "info" | "warn" | "error";

/**
 * An object argument; any class instance can stand in for it at run time.
 */
interface LogObject {
  readonly [key: string]: LogArgument;
}

/**
 * What Better Auth can pass after a message: its type is `any`, so this names every kind of value
 * an argument can be. `redactArgument` turns it into plain data.
 */
export type LogArgument =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Error
  | ((...args: ReadonlyArray<never>) => void)
  | ReadonlyMap<string, LogArgument>
  | ReadonlyArray<LogArgument>
  | LogObject;

/**
 * Starts an effect on the fiber runtime of the execution that built the instance and returns at
 * once, as `Effect.runForkWith(services)` does.
 */
export type Fork = (effect: Effect.Effect<void>) => void;

/**
 * An address whose quoted local part may hold spaces and escaped quotes, through the end of its
 * domain. The two alternatives of the group cannot match the same character, so it cannot
 * backtrack catastrophically.
 */
const QUOTED_LOCAL_PART = /"(?:[^"\\]|\\.)*"[@＠﹫]\S*/gu;

/**
 * The percent escape for `@`.
 */
const PERCENT_AT = /%40/giu;

/**
 * The HTML entities for `@`: decimal, hexadecimal and named.
 */
const AT_ENTITY = /&#0*64;|&#x0*40;|&commat;/giu;

/**
 * What stands in for a value the log cannot carry without risk.
 */
const NOT_LOGGABLE = "[not loggable]";

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
 * Decodes the percent escapes of a text, or gives no result when one is malformed.
 */
const decodeEscapes = Option.liftThrowable(decodeURIComponent);

/**
 * Decode the percent escapes of a text. A `%40` is always read as `@`, so a malformed escape
 * elsewhere in the token cannot hide it; any other malformed escape leaves the text as it was.
 *
 * @param text - A token.
 * @returns The decoded text.
 */
const percentDecoded = (text: string): string => {
  const withAt = text.replaceAll(PERCENT_AT, "@");

  return Option.getOrElse(decodeEscapes(withAt), () => withAt);
};

/**
 * Decode the HTML entities that spell an `@`.
 *
 * @param text - A token.
 * @returns The text with `&#64;`, `&#x40;` and `&commat;` replaced by `@`.
 */
const entityDecoded = (text: string): string => text.replaceAll(AT_ENTITY, "@");

/**
 * One round of percent and entity decoding.
 *
 * @param text - A token.
 * @returns The decoded token.
 */
const decodedOnce = (text: string): string => entityDecoded(percentDecoded(text));

/**
 * A token as a reader would see it after the usual encodings are undone: compatibility forms
 * folded (a full-width `＠` becomes `@`), then percent escapes and HTML entities decoded twice, so
 * a doubly encoded `@` is found too.
 *
 * @param token - A whitespace-free run of text.
 * @returns The token with its encodings undone.
 */
const decodedToken = (token: string): string =>
  decodedOnce(decodedOnce(token.normalize("NFKC"))).normalize("NFKC");

/**
 * Replace every whitespace-free run that contains an `@`, whole, in any common encoding, so a
 * list, a JSON document or a URL around an address leaves no fragment of it. A run that ends in
 * `@` or starts with `@` also takes the run beside it, which covers an address cut at a space, and
 * a quoted local part is replaced through its closing quote.
 *
 * @param text - A Better Auth message or argument.
 * @returns The text with each such run replaced by `[email]`.
 */
export const redactEmails = (text: string): string => {
  const tokens = text.replaceAll(QUOTED_LOCAL_PART, "[email]").split(WHITESPACE_RUNS);
  const decoded = tokens.map((token, index) => (index % 2 === 0 ? decodedToken(token) : token));
  const word = (index: number) => decoded[index] ?? "";

  return tokens
    .map((token, index) =>
      index % 2 === 0 &&
      (word(index).includes("@") ||
        word(index - 2).endsWith("@") ||
        word(index + 2).startsWith("@"))
        ? "[email]"
        : token,
    )
    .join("");
};

/**
 * The cause an `Error` carries, as a log argument; a missing cause is `null`, and a cause that
 * is not text, a number, a boolean or an object is replaced by a note.
 *
 * @param error - The error.
 * @returns The cause.
 */
const causeOf = (error: Error): LogArgument => {
  const { cause } = error;

  if (cause === undefined) {
    return null;
  }

  return Predicate.isError(cause) ||
    Predicate.isString(cause) ||
    Predicate.isNumber(cause) ||
    Predicate.isBoolean(cause) ||
    Predicate.isNull(cause)
    ? cause
    : NOT_LOGGABLE;
};

/**
 * Whether an object is a plain one: a literal, or one with no prototype.
 *
 * @param value - An object argument.
 * @returns `true` when its prototype is `Object.prototype` or `null`.
 */
const isPlainObject = (
  value: LogObject | ReadonlyMap<string, LogArgument> | ReadonlyArray<LogArgument>,
): boolean => {
  const prototype = Reflect.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

/**
 * Copy a log argument into plain data that fails closed. Text is redacted; arrays and plain
 * objects are walked, with their keys redacted, to `MAX_DEPTH` levels; an `Error` keeps its name,
 * message, stack and cause; a `Date` becomes its ISO text. Anything else, such as a function, a
 * symbol, a bigint, a `Map` or a class instance, is replaced by `[not loggable]`.
 *
 * @param argument - A Better Auth log argument.
 * @param depth - How many more levels may be copied.
 * @returns A copy that holds no address.
 */
const redactArgument = (argument: LogArgument, depth: number): Schema.Json => {
  if (Predicate.isString(argument)) {
    return redactEmails(argument);
  }

  if (Predicate.isNull(argument) || Predicate.isNumber(argument) || Predicate.isBoolean(argument)) {
    return argument;
  }

  if (Predicate.isUndefined(argument)) {
    return null;
  }

  if (
    Predicate.isBigInt(argument) ||
    Predicate.isSymbol(argument) ||
    Predicate.isFunction(argument)
  ) {
    return NOT_LOGGABLE;
  }

  if (Predicate.isDate(argument)) {
    return Number.isNaN(argument.getTime()) ? "[invalid date]" : argument.toISOString();
  }

  if (depth <= 0) {
    return "[truncated]";
  }

  if (Predicate.isError(argument)) {
    return {
      cause: redactArgument(causeOf(argument), depth - 1),
      message: redactEmails(argument.message),
      name: redactEmails(argument.name),
      stack: redactEmails(argument.stack ?? ""),
    };
  }

  if (Array.isArray(argument)) {
    return argument.map((item: LogArgument) => redactArgument(item, depth - 1));
  }

  if (!isPlainObject(argument)) {
    return NOT_LOGGABLE;
  }

  return Object.fromEntries(
    Object.entries(argument).map(([key, item]: [string, LogArgument]) => [
      redactEmails(key),
      redactArgument(item, depth - 1),
    ]),
  );
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
