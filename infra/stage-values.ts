import { Config, Effect, Option, Struct, pipe } from "effect";
import type { LogLevel } from "effect";
import type { Knob } from "@workspace/config/knob";
import { DocsEnabledKnob } from "@workspace/config/docs";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { LogLevelKnob } from "@workspace/config/log-level";
import { HeadSamplingRateKnob } from "@workspace/config/observability";
import { AuthCheckSessionTimeoutKnob, ProblemDetailsIncludeKnob } from "../apps/api/src/config.ts";
import { CookieCacheMaxAgeKnob, CookieCacheStrategyKnob } from "../apps/auth/src/config.ts";
import { kindOf } from "./stages.ts";
import type { StageName } from "./stages.ts";

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
  readonly DOCS_ENABLED: typeof DocsEnabledKnob.default;
  readonly AUTH_CHECK_SESSION_TIMEOUT_MS: typeof AuthCheckSessionTimeoutKnob.default;
  readonly AUTH_COOKIE_CACHE_MAX_AGE_S: typeof CookieCacheMaxAgeKnob.default;
  readonly AUTH_COOKIE_CACHE_STRATEGY: typeof CookieCacheStrategyKnob.default;
  readonly AUTH_PASSWORD_SCRYPT: typeof AUTH_PASSWORD_SCRYPT.default;
  readonly HEAD_SAMPLING_RATE: typeof HeadSamplingRateKnob.default;
  readonly LOG_LEVEL: LogLevel.LogLevel;
  readonly PROBLEM_DETAILS_INCLUDE: typeof ProblemDetailsIncludeKnob.default;
}

/**
 * The knob values of one stage kind: the given log level, the given `api` switches and every other
 * knob at its default.
 *
 * @param logLevel - The raw `LOG_LEVEL` value of the kind.
 * @param api - The `api` switches of the kind, all off on `prod`.
 * @param api.docs - Whether the docs knob is on, so `api` serves the OpenAPI document, the
 *   reference page and `llms.txt`.
 * @param api.exampleFeature - Whether the example notes feature is on.
 * @param api.problemDetails - Whether a 400 problem body lists the validation issues.
 * @returns The validated values of the kind.
 */
const stageRow = (
  logLevel: string,
  api: {
    readonly docs: string;
    readonly problemDetails: string;
  },
): StageValues => ({
  AUTH_CHECK_SESSION_TIMEOUT_MS: validated(AuthCheckSessionTimeoutKnob, "1500"),
  AUTH_COOKIE_CACHE_MAX_AGE_S: CookieCacheMaxAgeKnob.default,
  AUTH_COOKIE_CACHE_STRATEGY: CookieCacheStrategyKnob.default,
  AUTH_PASSWORD_SCRYPT: AUTH_PASSWORD_SCRYPT.default,
  DOCS_ENABLED: validated(DocsEnabledKnob, api.docs),
  HEAD_SAMPLING_RATE: validated(HeadSamplingRateKnob, "1"),
  LOG_LEVEL: validated(LogLevelKnob, logLevel),
  PROBLEM_DETAILS_INCLUDE: validated(ProblemDetailsIncludeKnob, api.problemDetails),
});

/**
 * The tier (b) knob values per stage kind, each validated by its knob codec when the module
 * loads. Each knob-adding block adds its key and a value per kind.
 */
export const Stages: Record<ReturnType<typeof kindOf>, StageValues> = {
  local: stageRow("Debug", {
    docs: "true",
    problemDetails: "true",
  }),
  prod: stageRow("Info", {
    docs: "false",
    problemDetails: "false",
  }),
  staging: stageRow("Debug", {
    docs: "true",
    problemDetails: "true",
  }),
  test: stageRow("Debug", {
    docs: "true",
    problemDetails: "true",
  }),
};

/**
 * The knob behind every knob value of {@link StageValues}, the one list the test-stage overrides
 * derive from. A knob-adding block adds its knob here and its field to {@link StageValues}.
 */
const stageKnobs = {
  AUTH_CHECK_SESSION_TIMEOUT_MS: AuthCheckSessionTimeoutKnob,
  AUTH_COOKIE_CACHE_MAX_AGE_S: CookieCacheMaxAgeKnob,
  AUTH_COOKIE_CACHE_STRATEGY: CookieCacheStrategyKnob,
  AUTH_PASSWORD_SCRYPT,
  DOCS_ENABLED: DocsEnabledKnob,
  HEAD_SAMPLING_RATE: HeadSamplingRateKnob,
  LOG_LEVEL: LogLevelKnob,
  PROBLEM_DETAILS_INCLUDE: ProblemDetailsIncludeKnob,
};

/**
 * Turn a knob into the reader of its `STAGES_TEST_<KEY>` override: the decoded value, or none.
 */
interface ReadOverride extends Struct.Lambda {
  <A>(self: Knob<A>): Config.Config<Option.Option<A>>;
  readonly "~lambda.out": Config.Config<
    Option.Option<this["~lambda.in"] extends Knob<infer A> ? A : never>
  >;
}

/**
 * Turn an override into the function that picks it over a base value.
 */
interface PickOverride extends Struct.Lambda {
  <A>(self: Option.Option<A>): (base: A) => A;
  readonly "~lambda.out": (
    base: this["~lambda.in"] extends Option.Option<infer A> ? A : never,
  ) => this["~lambda.in"] extends Option.Option<infer A> ? A : never;
}

const readOverride = Struct.lambda<ReadOverride>((knob) => knob.override("STAGES_TEST_"));

const pickOverride = Struct.lambda<PickOverride>(
  (override) => (base) => Option.getOrElse(override, () => base),
);

/**
 * Read the knob values of a stage.
 *
 * For the `test` kind, every knob of {@link stageKnobs} is replaced by the environment variable
 * `STAGES_TEST_<KEY>` when it is set, decoded by the knob's own schema, so a test deploy can flip
 * one value without editing {@link Stages}. Other kinds ignore the variables.
 *
 * @param stage - The decoded stage.
 * @returns The knob values, or the failure of an invalid override.
 */
export const stageValues = Effect.fn("stageValues")(function* stageValues(
  stage: StageName,
): Effect.fn.Return<StageValues, Config.ConfigError> {
  const kind = kindOf(stage);
  const base = Stages[kind];

  if (kind !== "test") {
    return base;
  }

  const overrides = yield* Config.all(pipe(stageKnobs, Struct.map(readOverride)));

  return Struct.evolve(base, pipe(overrides, Struct.map(pickOverride)));
});
