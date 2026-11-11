import { Schema } from "effect";

/**
 * The sign-in methods the deployment offers: the OAuth provider ids that are live, and whether the
 * mail add-in is live.
 *
 * `email` means the mail add-in sends reset and verification mail. It does not mean the password
 * form, which always exists. `infra` is the one producer; `auth` and `web` only read the value.
 */
export const AuthMethods = Schema.Struct({
  email: Schema.Boolean,
  providers: Schema.Array(Schema.String),
});

/**
 * Decode the JSON text bound as `AUTH_METHODS` into {@link AuthMethods}.
 *
 * @param json - The JSON text `infra` binds.
 * @returns The decoded value, or the `SchemaError` of text that is not valid JSON or has the
 *   wrong shape.
 */
export const decodeAuthMethods = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AuthMethods))(json);
