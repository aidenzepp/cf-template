import { Effect, Schema, SchemaTransformation } from "effect";
import { base32Sha256 } from "./base32-sha256.ts";

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
 * Classify a decoded stage by its kind.
 *
 * @param stage - A stage decoded by {@link Stage}.
 * @returns The kind that owns the stage's knob values.
 */
export const kindOf = (stage: StageName) => {
  if (stage === "prod") {
    return "prod";
  }

  if (stage === "dev") {
    return "local";
  }

  return stage.startsWith("staging-") ? "staging" : "test";
};

/**
 * The Worker ids every stage deploys, the one list the Worker count and the longest Worker name
 * derive from.
 */
export const Workers = ["web", "api", "auth"] as const;

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
// probe S4: infra-only edit for the #474 cache measurement
