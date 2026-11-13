import { Config, Schema } from "effect";

/**
 * The OAuth providers a deployment can offer. A provider is live only when both of its credentials
 * are set.
 */
export const ProviderId = Schema.Literals(["github", "google"]);

/**
 * The sign-in methods the deployment offers: the OAuth provider ids that are live, and whether the
 * mail add-in is live.
 *
 * `email` means the mail add-in sends reset and verification mail. It does not mean the password
 * form, which always exists. `infra` is the one producer; `auth` and `web` only read the value.
 */
export const AuthMethods = Schema.Struct({
  email: Schema.Boolean,
  providers: Schema.Array(ProviderId),
});

/**
 * The `Config` that decodes the JSON text bound as `AUTH_METHODS` into {@link AuthMethods}. A
 * missing binding, invalid JSON or a wrong shape fails through the `Config` error channel.
 */
export const AUTH_METHODS = Config.schema(Schema.fromJsonString(AuthMethods), "AUTH_METHODS");

/**
 * Decode the JSON text bound as `AUTH_METHODS` into {@link AuthMethods}.
 *
 * @param json - The JSON text `infra` binds.
 * @returns The decoded value, or the `SchemaError` of text that is not valid JSON or has the
 *   wrong shape.
 */
export const decodeAuthMethods = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(AuthMethods))(json);
