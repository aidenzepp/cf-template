import { Option, Predicate, Schema } from "effect";

/**
 * A JSON object, as a plain record so it can be spread.
 */
export type JsonRecord = Readonly<Record<string, Schema.Json>>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * The text of a request body, when the client sent bytes or a string.
 */
const textOf: (raw: RequestInit["body"]) => string | undefined = (raw) => {
  if (Predicate.isUint8Array(raw)) {
    return new TextDecoder().decode(raw);
  }

  return Predicate.isString(raw) ? raw : undefined;
};

/**
 * Read a request body as JSON; no body is `null`.
 */
export const readBody = (init: RequestInit | undefined) =>
  Option.fromNullishOr(textOf(init?.body)).pipe(
    Option.flatMap(decodeJson),
    Option.getOrElse<Schema.Json>(() => null),
  );
