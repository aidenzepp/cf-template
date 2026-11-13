import { createSerializationAdapter } from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Predicate } from "effect";

/**
 * The message of an {@link AuthUnavailable}. The router serializes an error to its message alone,
 * so the browser recognizes the failure by this text, not by its class.
 */
const AUTH_UNAVAILABLE_MESSAGE = new AuthUnavailable({ retryAfterSeconds: 0 }).message;

/**
 * Whether a route error is the sign-in outage the root `beforeLoad` reports.
 *
 * @param error - The error being serialized.
 * @returns `true` for an {@link AuthUnavailable}, on the server and after hydration.
 */
const isAuthUnavailable = (error: Error): boolean => error.message === AUTH_UNAVAILABLE_MESSAGE;

/**
 * The text a dehydrated error carries when it is not the declared sign-in outage.
 */
const HIDDEN_ERROR_MESSAGE = "error";

/**
 * Serializes every `Error` into the dehydrated router state without its text, so a defect's
 * message never reaches the browser inside the SSR `<script>`. The one declared failure the
 * browser must recognize, the sign-in outage, keeps its message; the router's own `notFound` and
 * redirects are not `Error`s and pass through untouched. Start's adapters precede the router's
 * default `Error` serializer, which would send the message of any error.
 */
const hiddenErrorAdapter = createSerializationAdapter<Error, { readonly message: string }>({
  fromSerializable: ({ message }) => new Error(message),
  key: "hidden-error",
  test: (value): value is Error => value instanceof Error,
  toSerializable: (error) => ({
    message: isAuthUnavailable(error) ? error.message : HIDDEN_ERROR_MESSAGE,
  }),
});

/**
 * Whether a value is a dehydrated match whose loader failed with something that is not an `Error`:
 * a bare string or a plain object. The router stores whatever the loader threw in `e` beside the
 * status `s`, and `hiddenErrorAdapter` only sees `Error`s.
 */
const isNonErrorFailure = (value: unknown): value is object =>
  Predicate.hasProperty(value, "s") &&
  value.s === "error" &&
  Predicate.hasProperty(value, "i") &&
  Predicate.hasProperty(value, "u") &&
  Predicate.hasProperty(value, "e") &&
  !(value.e instanceof Error);

/**
 * Replaces the thrown value of a failed match with the `Error` that `hiddenErrorAdapter` then
 * serializes without its text, so a loader's failure reaches the browser the same way whether it
 * threw an `Error` or something else. The pair of `s` and `e` in a dehydrated match is how a thrown
 * value is told apart from loader data. The match travels inside `match` so the serialized form
 * does not match this adapter again.
 */
const hiddenFailureAdapter = createSerializationAdapter<object, { readonly match: object }>({
  fromSerializable: ({ match }) => match,
  key: "hidden-failure",
  test: isNonErrorFailure,
  toSerializable: (match) => ({ match: { ...match, e: new Error(HIDDEN_ERROR_MESSAGE) } }),
});

export const startInstance = createStart(() => ({
  serializationAdapters: [hiddenErrorAdapter, hiddenFailureAdapter],
}));
