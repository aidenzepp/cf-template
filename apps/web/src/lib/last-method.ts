import { Effect, Option, Schema } from "effect";

/**
 * The sign-in methods the screen remembers: the name of the method, never an email or any other
 * identifier.
 */
export const signInMethod = Schema.Literals(["email", "passkey"]);

/**
 * One of {@link signInMethod}.
 */
export type SignInMethod = typeof signInMethod.Type;

/**
 * The `localStorage` key of the record. The record is per browser profile and never leaves it.
 */
export const LAST_METHOD_KEY = "last-sign-in-method";

/**
 * The part of `Storage` the record uses.
 */
export interface MethodStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

/**
 * Opens a store; throws, as `window.localStorage` does when site data is blocked.
 */
export type OpenStore = () => MethodStore;

/**
 * Reads the method the last successful sign-in on this device used. A store that cannot be opened
 * or read, and any value that is not a known method, mean no record.
 *
 * @param open - Opens the store.
 * @returns The method, or none.
 */
export const readLastMethod = (open: OpenStore): Effect.Effect<Option.Option<SignInMethod>> =>
  Effect.try({ catch: (cause) => cause, try: () => open().getItem(LAST_METHOD_KEY) }).pipe(
    Effect.map((raw) => Schema.decodeUnknownOption(signInMethod)(raw)),
    Effect.orElseSucceed(Option.none<SignInMethod>),
  );

/**
 * Records the method of a successful sign-in. A store that cannot be written is ignored: the badge
 * is a convenience and never blocks a sign-in.
 *
 * @param open - Opens the store.
 * @param method - The method that just signed the person in.
 * @returns The effect to run.
 */
export const recordMethod = (open: OpenStore, method: SignInMethod): Effect.Effect<void> =>
  Effect.try({
    catch: (cause) => cause,
    try: () => {
      open().setItem(LAST_METHOD_KEY, method);
    },
  }).pipe(Effect.ignore);
