import { Effect } from "effect";

/**
 * The levels Better Auth passes to `logger.log`; its `success` is delivered as `info`.
 */
type BetterAuthLevel = "debug" | "info" | "warn" | "error";

/**
 * Starts an effect on the fiber runtime of the execution that built the instance and returns at
 * once, as `Effect.runForkWith(services)` does.
 */
export type Fork = (effect: Effect.Effect<void>) => void;

/**
 * Any run of non-space characters around an `@`: an address, whatever surrounds it.
 */
const EMAIL_ADDRESS = /[^\s@]+@[^\s@]+/gu;

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
 * Replace every email-shaped substring of a text.
 *
 * @param text - A Better Auth message or argument.
 * @returns The text with each address replaced by `[email]`.
 */
export const redactEmails = (text: string): string => text.replaceAll(EMAIL_ADDRESS, "[email]");

/**
 * The Better Auth `logger` option: every message goes through the Effect logger of the execution
 * with every address replaced, at the level Better Auth gave it.
 *
 * Better Auth interpolates the submitted address into some messages, such as the duplicate sign-up
 * line of `sign-up.mjs`, and the repository keeps addresses out of its logs. Extra arguments are
 * reduced to their redacted text, so an `Error` carries its message and no stack. `info` is the
 * lowest level published; the Effect logger's own minimum still applies.
 *
 * @param fork - Starts a log effect under the services the instance was built with.
 * @returns The `logger` option.
 */
export const betterAuthLogger = (fork: Fork) => ({
  level: "info" as const,
  log: (level: BetterAuthLevel, message: string, ...args: ReadonlyArray<unknown>) => {
    const text = [message, ...args.map((arg) => (arg instanceof Error ? arg.message : String(arg)))]
      .map(redactEmails)
      .join(" ");

    fork(EFFECT_LOGGER[level](text));
  },
});
