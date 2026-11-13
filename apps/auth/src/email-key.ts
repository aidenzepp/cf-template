import { Effect, Layer, Redacted } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

/**
 * The name of the `auth` binding that holds the HMAC secret of {@link emailKey}, and the logical id
 * of the Alchemy resource `infra` mints it from. `bun run log-key` reads the resource back by this
 * id.
 */
export const EMAIL_KEY_SECRET_ID = "EmailKeySecret";

/**
 * The one name under which a keyed email hash appears in a log line.
 */
export const EMAIL_KEY_FIELD = "emailKey";

/**
 * The form of an address that is hashed: Unicode NFC, trimmed of surrounding whitespace, then
 * lower-cased. It is the one normalization, so `Ada@Example.test ` and `ada@example.test` share a
 * key, as do composed and decomposed accents.
 *
 * @param email - An address as typed.
 * @returns The normalized address.
 */
const normalizeEmail = (email: string): string =>
  email.normalize("NFC").trim().toLowerCase();

/**
 * `Mac` on WebCrypto, the layer {@link emailKey} runs on.
 */
const macLayer = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

/**
 * The keyed hash of an address: HMAC-SHA256 over its {@link normalizeEmail} form, as 64 lower-case
 * hex characters.
 *
 * The hash is stable for one secret, so a maintainer can search the logs for a known address, and
 * it reveals nothing about the address to a reader without the secret.
 *
 * @param secret - The secret bound as `EMAIL_KEY_SECRET`.
 * @param email - The address as typed.
 * @returns The hash, or a `CryptoError` when the secret is empty.
 */
export const emailKey = Effect.fn("auth.emailKey")(function* emailKey(
  secret: Redacted.Redacted,
  email: string,
) {
  const encoder = new TextEncoder();
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(Redacted.value(secret)));

  return Hex.encode(yield* mac.sign(key, encoder.encode(normalizeEmail(email))));
}, Effect.provide(macLayer));
