import { createSerializationAdapter } from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";
import { isAuthUnavailable } from "./components/retry.tsx";

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

export const startInstance = createStart(() => ({
  serializationAdapters: [hiddenErrorAdapter],
}));
