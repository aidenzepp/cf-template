import { Effect } from "effect";
import { Digest } from "effect/crypto";

/**
 * The RFC 4648 base32 alphabet in lower case, the only case a stage or stack name may use.
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encode the SHA-256 digest of `input` in lower-case base32 and keep its first `length`
 * characters.
 *
 * The digest comes from the effectful `Digest` service of `effect/crypto`, so a Schema transform
 * that normalizes a long slug with it is effectful too and requires `Digest` to decode.
 *
 * @param input - The text to hash.
 * @param length - How many base32 characters to keep.
 * @returns The first `length` base32 characters of `sha256(input)`.
 */
export const base32Sha256 = Effect.fn("base32Sha256")(function* base32Sha256(
  input: string,
  length: number,
) {
  const digest = yield* Digest.Digest;
  const bytes = yield* digest.digest(Digest.sha256, new TextEncoder().encode(input));
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const chunks = bits.match(/.{1,5}/gu) ?? [];

  return chunks
    .map((chunk) => BASE32_ALPHABET.charAt(Number.parseInt(chunk.padEnd(5, "0"), 2)))
    .join("")
    .slice(0, length);
});
