import { Config, Effect, Option, Schema, SchemaTransformation } from "effect";
import type { LogLevel } from "effect";
import { Digest } from "effect/crypto";
import { ApiDocsEnabledKnob } from "@workspace/config/api-docs";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { LogLevelKnob } from "@workspace/config/log-level";
import { HeadSamplingRateKnob } from "@workspace/config/observability";
import { AuthCheckSessionTimeoutKnob, ProblemDetailsIncludeKnob } from "../apps/api/src/config.ts";
// block:notes start
import { ExampleFeatureKnob } from "../apps/api/src/notes/knob.ts";
// block:notes end
import { CookieCacheMaxAgeKnob, CookieCacheStrategyKnob } from "../apps/auth/src/config.ts";

/**
 * The longest Worker name Cloudflare accepts.
 */
const WORKER_NAME_MAX = 54;

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
 * The stage name, decoded from `stack.stage` before any resource is declared.
 *
 * It is `prod`, `staging-<N>` of at most six digits, `test-ci`, `test-<slug>` with a slug of
 * `[a-z0-9-]`, or `dev`, the local stage of `alchemy dev`. A slug longer than 14 characters is
 * normalized to its first 8 characters and 6 base32 characters of `sha256(slug)`. Upper case,
 * `_` and `dev-<user>` are rejected.
 */
export const Stage = Schema.Union([
  Schema.Literals(["prod", "dev", "test-ci"]),
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
export type StageKind = "prod" | "staging" | "test" | "local";

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
 * The Worker ids every stage deploys, the one list the Worker count and the longest Worker name
 * derive from.
 *
 * A block that adds a Worker adds its id on one line marked `// block:<unit>`.
 */
export const Workers = ["web", "api", "auth"] as const;

/**
 * The length of the longest entry of {@link Workers}.
 */
const LONGEST_WORKER = Math.max(...Workers.map((worker) => worker.length));

/**
 * The length of the longest stage {@link Stage} accepts, derived from the same bounds the Schema
 * is built from.
 */
export const LONGEST_STAGE = Math.max(
  "prod".length,
  "dev".length,
  "test-ci".length,
  "staging-".length + STAGING_DIGITS_MAX,
  "test-".length + TEST_SLUG_MAX,
);

/**
 * The longest stack name that keeps `<stack>-<worker>-<stage>` inside the Worker name limit for
 * the longest Worker and the longest stage.
 */
export const STACK_NAME_MAX = WORKER_NAME_MAX - LONGEST_WORKER - 2 - LONGEST_STAGE;

/**
 * The failure raised when a derived Worker name exceeds the Worker name limit.
 */
export class WorkerNameTooLongError extends Schema.TaggedError<WorkerNameTooLongError>()(
  "WorkerNameTooLongError",
  { message: Schema.String, workerName: Schema.String },
) {}

/**
 * Construct the name of a Worker for a stage as `<stack>-<worker>-<stage>`, lower case.
 *
 * @param parts - The parts of the name.
 * @param parts.stack - The stack name from `resolveStackName`.
 * @param parts.worker - The Worker id, an entry of {@link Workers}.
 * @param parts.stage - The decoded stage.
 * @returns The Worker name, or a {@link WorkerNameTooLongError} when the name exceeds the Worker
 *   name limit.
 */
export const workerName = (parts: {
  readonly stack: string;
  readonly worker: string;
  readonly stage: StageName;
}): Effect.Effect<string, WorkerNameTooLongError> => {
  const name = `${parts.stack}-${parts.worker}-${parts.stage}`.toLowerCase();

  return name.length > WORKER_NAME_MAX
    ? Effect.fail(
        new WorkerNameTooLongError({
          message: `Worker name ${name} is ${name.length} characters; Cloudflare accepts at most ${WORKER_NAME_MAX}. Shorten the stack name or the stage.`,
          workerName: name,
        }),
      )
    : Effect.succeed(name);
};

/**
 * Decode `raw` through `knob`, failing at module load when it is invalid.
 *
 * @param knob - The knob whose codec validates the value.
 * @param knob.decodeSync - The knob's synchronous string codec.
 * @param raw - The string form of the value.
 * @returns The decoded value.
 */
const validated = <A>(knob: { readonly decodeSync: (raw: string) => A }, raw: string): A =>
  knob.decodeSync(raw);

/**
 * The knob values of one stage kind.
 */
export interface StageValues {
  readonly API_DOCS_ENABLED: typeof ApiDocsEnabledKnob.default;
  readonly AUTH_CHECK_SESSION_TIMEOUT_MS: typeof AuthCheckSessionTimeoutKnob.default;
  readonly AUTH_COOKIE_CACHE_MAX_AGE_S: typeof CookieCacheMaxAgeKnob.default;
  readonly AUTH_COOKIE_CACHE_STRATEGY: typeof CookieCacheStrategyKnob.default;
  readonly AUTH_PASSWORD_SCRYPT: typeof AUTH_PASSWORD_SCRYPT.default;
  // block:notes start
  readonly EXAMPLE_FEATURE_ENABLED: typeof ExampleFeatureKnob.default;
  // block:notes end
  readonly HEAD_SAMPLING_RATE: typeof HeadSamplingRateKnob.default;
  readonly LOG_LEVEL: LogLevel.LogLevel;
  readonly PROBLEM_DETAILS_INCLUDE: typeof ProblemDetailsIncludeKnob.default;
  /**
   * Whether the stage declares the requests-count volume alert. A plain stage flag, not a knob.
   */
  readonly volumeAlert: boolean;
}

/**
 * The knob values of one stage kind: the given log level, the given `api` switches and every other
 * knob at its default.
 *
 * @param logLevel - The raw `LOG_LEVEL` value of the kind.
 * @param api - The `api` switches of the kind, all off on `prod`.
 * @param api.docs - Whether `api` serves the OpenAPI document, the reference page and `llms.txt`.
 * @param api.exampleFeature - Whether the example notes feature is on.
 * @param api.problemDetails - Whether a 400 problem body lists the validation issues.
 * @param volumeAlert - Whether the kind declares the volume alert.
 * @returns The validated values of the kind.
 */
const stageRow = (
  logLevel: string,
  api: {
    readonly docs: string;
    // block:notes start
    readonly exampleFeature: string;
    // block:notes end
    readonly problemDetails: string;
  },
  volumeAlert: boolean,
): StageValues => ({
  API_DOCS_ENABLED: validated(ApiDocsEnabledKnob, api.docs),
  AUTH_CHECK_SESSION_TIMEOUT_MS: validated(AuthCheckSessionTimeoutKnob, "1500"),
  AUTH_COOKIE_CACHE_MAX_AGE_S: CookieCacheMaxAgeKnob.default,
  AUTH_COOKIE_CACHE_STRATEGY: CookieCacheStrategyKnob.default,
  AUTH_PASSWORD_SCRYPT: AUTH_PASSWORD_SCRYPT.default,
  // block:notes start
  EXAMPLE_FEATURE_ENABLED: validated(ExampleFeatureKnob, api.exampleFeature),
  // block:notes end
  HEAD_SAMPLING_RATE: validated(HeadSamplingRateKnob, "1"),
  LOG_LEVEL: validated(LogLevelKnob, logLevel),
  PROBLEM_DETAILS_INCLUDE: validated(ProblemDetailsIncludeKnob, api.problemDetails),
  volumeAlert,
});

/**
 * The tier (b) knob values per stage kind, each validated by its knob codec when the module
 * loads. Each knob-adding block adds its key and a value per kind.
 */
export const Stages: Record<StageKind, StageValues> = {
  local: stageRow(
    "Debug",
    {
      docs: "true",
      // block:notes start
      exampleFeature: "true",
      // block:notes end
      problemDetails: "true",
    },
    false,
  ),
  prod: stageRow(
    "Info",
    {
      docs: "false",
      // block:notes start
      exampleFeature: "false",
      // block:notes end
      problemDetails: "false",
    },
    true,
  ),
  staging: stageRow(
    "Debug",
    {
      docs: "true",
      // block:notes start
      exampleFeature: "true",
      // block:notes end
      problemDetails: "true",
    },
    false,
  ),
  test: stageRow(
    "Debug",
    {
      docs: "true",
      // block:notes start
      exampleFeature: "true",
      // block:notes end
      problemDetails: "true",
    },
    true,
  ),
};

/**
 * Read the knob values of a stage.
 *
 * For the `test` kind, a key is replaced by the environment variable `STAGES_TEST_<KEY>` when it
 * is set, decoded by the same knob codec, so a test deploy can flip one value without editing
 * {@link Stages}. Other kinds ignore the variable.
 *
 * @param stage - The decoded stage.
 * @returns The knob values, or the failure of an invalid override.
 */
export const stageValues = Effect.fn("stageValues")(function* stageValues(
  stage: StageName,
): Effect.fn.Return<StageValues, Config.ConfigError | Schema.SchemaError> {
  const kind = kindOf(stage);
  const base = Stages[kind];

  if (kind !== "test") {
    return base;
  }

  const logLevel = yield* Config.String(`STAGES_TEST_${LogLevelKnob.key}`).pipe(Config.option);

  return {
    ...base,
    LOG_LEVEL: Option.isSome(logLevel)
      ? yield* LogLevelKnob.decode(logLevel.value)
      : base.LOG_LEVEL,
  };
});
