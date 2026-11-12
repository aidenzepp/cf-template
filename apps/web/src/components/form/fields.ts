import { Schema } from "effect";

/**
 * A text field that must not be empty.
 *
 * @param message - What to tell a person who left it empty.
 * @returns The field's schema.
 */
export const required = (message: string) => Schema.String.check(Schema.isNonEmpty({ message }));

/**
 * An email field: not empty, and shaped like an address. The server owns the real check.
 */
export const emailField = required("Enter your email.").check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+$/u, { message: "Enter an email like ada@example.com." }),
);
