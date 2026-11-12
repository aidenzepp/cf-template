import { Option, Schema } from "effect";

const decodeText = Schema.decodeUnknownOption(Schema.String);

/**
 * Read a text field of a submitted form.
 *
 * @param form - The submitted form's data.
 * @param name - The field's name.
 * @returns The field's text, or an empty string for a missing or file field.
 */
export const readField = (form: FormData, name: string): string => {
  const value = form.get(name);

  return Option.getOrElse(decodeText(value), () => "");
};
