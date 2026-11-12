import { Effect, Option, Predicate, Schema, SchemaIssue } from "effect";

/**
 * The message of each invalid field of a submitted form, keyed by the field's `name`. A field
 * with no entry decoded.
 */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * Turns a schema failure into one line per field. A check says its own line through the
 * `message` annotation of the check; a field that is missing or the wrong kind asks to be filled
 * in; a check without a line asks for a second look. The parser's own wording never reaches a
 * person.
 */
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: (issue) => SchemaIssue.defaultCheckHook(issue) ?? "Check this field.",
  leafHook: () => "Fill in this field.",
});

/**
 * The first step of an issue's path: a field's name, as a bare key or as a path segment.
 */
const decodeFieldKey = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Struct({ key: Schema.String })]),
);

/**
 * Maps the issues of a failed decode to the field each one belongs to. A field with several
 * issues keeps the first. An issue with no path names no field and is dropped.
 *
 * @param issue - The issue of a schema failure.
 * @returns The message of each invalid field.
 */
export const fieldErrorsOf = (issue: SchemaIssue.Issue): FieldErrors =>
  Object.fromEntries(
    formatIssues(issue)
      .issues.flatMap(({ message, path }) =>
        Option.match(decodeFieldKey(path?.[0]), {
          onNone: () => [],
          onSome: (first) => [[Predicate.isString(first) ? first : first.key, message] as const],
        }),
      )
      .toReversed(),
  );

/**
 * The fields of a submitted form with the schema that decodes them: the schema's `Type` is what
 * the submit effect receives.
 */
export type FormSchema = Schema.Decoder<unknown>;

/**
 * Decodes a submitted form with a schema. A field the form does not hold is a missing key; a file
 * field reaches the schema as a `File`, which a string field rejects.
 *
 * @param schema - The schema of the form's fields, which names each field as the input's `name`.
 * @returns A function from the submitted data to the decoded value, which fails with the message
 *   of each invalid field.
 */
export const decodeForm =
  <S extends FormSchema>(schema: S) =>
  (form: FormData): Effect.Effect<S["Type"], FieldErrors> =>
    Schema.decodeUnknownEffect(schema)(Object.fromEntries(form), { errors: "all" }).pipe(
      Effect.mapError(({ issue }) => fieldErrorsOf(issue)),
    );
