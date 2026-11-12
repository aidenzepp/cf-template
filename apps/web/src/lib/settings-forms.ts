import { Schema } from "effect";
import { required } from "../components/form/fields.ts";

/**
 * The fields of the profile form. The image is a link, or empty to remove it.
 */
export const ProfileInput = Schema.Struct({
  image: Schema.String.check(
    Schema.isPattern(/^(?:https?:\/\/\S+)?$/u, {
      message: "Enter a link that starts with https://.",
    }),
  ),
  name: required("Enter your name."),
});

/**
 * The fields of the password form. An unchecked box sends no `revoke` field.
 */
export const PasswordInput = Schema.Struct({
  current: required("Enter your current password."),
  next: required("Choose a new password."),
  revoke: Schema.optionalKey(Schema.String),
});

/**
 * The field of the form that renames a passkey.
 */
export const PasskeyNameInput = Schema.Struct({ name: required("Enter a name.") });

/**
 * The field of the form that adds a passkey; a passkey may have no name.
 */
export const NewPasskeyInput = Schema.Struct({ name: Schema.String });
