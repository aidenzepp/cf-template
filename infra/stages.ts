import { Effect, Schema, SchemaTransformation } from "effect";
import { Digest } from "effect/crypto";

/**
 * The most characters a `test-<slug>` stage keeps in its slug.
 */
const TEST_SLUG_MAX = 14;

/**
 * The most digits a `staging-<N>` stage accepts after its prefix.
 */
const STAGING_DIGITS_MAX = 6;

/**
 * The base32 characters of `sha256` that end a normalized name.
 */
const HASH_TAIL_LENGTH = 6;

/**
 * The RFC 4648 base32 alphabet in lower case, the only case a stage or stack name may use.
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encode the SHA-256 digest of `input` in lower-case base32 and keep its first `length`
 * characters.
 *
 * The digest comes from the effectful `Digest` service of `effect/crypto`, so the Schema
 * transform that normalizes a long slug is effectful too and {@link Stage} requires `Digest`
 * to decode.
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

/**
 * Replace the slug of a `test-<slug>` stage with its first characters and a hash tail when it
 * is longer than {@link TEST_SLUG_MAX}, so the result is exactly {@link TEST_SLUG_MAX} slug
 * characters.
 *
 * @param stage - A `test-<slug>` stage whose slug uses `[a-z0-9-]`.
 * @returns The stage unchanged when its slug fits, otherwise the normalized stage.
 */
const normalizeTestStage = Effect.fn("normalizeTestStage")(function* normalizeTestStage(
  stage: string,
) {
  const slug = stage.slice("test-".length);

  return slug.length <= TEST_SLUG_MAX
    ? stage
    : `test-${slug.slice(0, TEST_SLUG_MAX - HASH_TAIL_LENGTH)}${yield* base32Sha256(slug, HASH_TAIL_LENGTH)}`;
});

/**
 * The one stage `test:cloud` deploys: fixed, serialized, and kept in the project state store.
 *
 * It is declared without a type annotation so its literal type is assignable to {@link StageName};
 * an annotation of `StageName` would be circular, because {@link Stage} reads this constant.
 * `package.json` and the workflows cannot import it, so tests compare their spellings of it.
 */
export const CLOUD_STAGE = "test-ci";

/**
 * The stage name, decoded from `stack.stage` before any resource is declared.
 *
 * It is `prod`, `staging-<N>` of at most six digits, `test-ci`, `test-<slug>` with a slug of
 * `[a-z0-9-]`, or `dev`, the local stage of `alchemy dev`. A slug longer than 14 characters is
 * normalized to its first 8 characters and 6 base32 characters of `sha256(slug)`. Upper case,
 * `_` and `dev-<user>` are rejected.
 */
export const Stage = Schema.Union([
  Schema.Literals(["prod", "dev", CLOUD_STAGE]),
  Schema.String.check(
    Schema.isPattern(new RegExp(`^staging-[0-9]{1,${STAGING_DIGITS_MAX}}$`, "u")),
  ),
  Schema.String.check(Schema.isPattern(/^test-[a-z0-9-]+$/u)).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: normalizeTestStage,
        encode: (stage: string) => Effect.succeed(stage),
      }),
    ),
  ),
]);

/**
 * A decoded stage name.
 */
export type StageName = typeof Stage.Type;

/**
 * The kind of a stage, which selects its row of {@link Stages}. `test-ci` and `test-<slug>` are
 * both the `test` kind.
 */
type StageKind = "prod" | "staging" | "test" | "local";

/**
 * Classify a decoded stage by its kind.
 *
 * @param stage - A stage decoded by {@link Stage}.
 * @returns The kind that owns the stage's knob values.
 */
export const kindOf = (stage: StageName): StageKind => {
  if (stage === "prod") {
    return "prod";
  }

  if (stage === "dev") {
    return "local";
  }

  return stage.startsWith("staging-") ? "staging" : "test";
};

/**
 * The length of the longest stage {@link Stage} accepts, derived from the same bounds the Schema
 * is built from.
 */
export const LONGEST_STAGE = Math.max(
  "prod".length,
  "dev".length,
  CLOUD_STAGE.length,
  "staging-".length + STAGING_DIGITS_MAX,
  "test-".length + TEST_SLUG_MAX,
);
