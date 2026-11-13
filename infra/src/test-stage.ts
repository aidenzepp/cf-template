import { Effect, Schema } from "effect";
import { usesProjectState } from "./state-selection.ts";

/**
 * The phases the guarded script may run with `--yes`.
 */
const TEST_STAGE_PHASES = ["deploy", "destroy"] as const;

/**
 * One of {@link TEST_STAGE_PHASES}.
 */
export type TestStagePhase = (typeof TEST_STAGE_PHASES)[number];

/**
 * The shape of a throwaway stage: `test-` and a lower case alphanumeric slug.
 */
const TEST_STAGE_PATTERN = /^test-[a-z0-9-]+$/u;

/**
 * The refusal of a stage or phase the guarded script does not run with `--yes`, raised before any
 * `alchemy` call.
 */
export class TestStageRefused extends Schema.TaggedError<
  TestStageRefused,
  { readonly brand: unique symbol }
>()("TestStageRefused", {
  message: Schema.String,
}) {}

const isPhase = (value: string): value is TestStagePhase =>
  TEST_STAGE_PHASES.some((phase) => phase === value);

/**
 * Decide whether `phase` on `stage` may run with `--yes`.
 *
 * Both must hold for a stage: it matches {@link TEST_STAGE_PATTERN}, and the stack program keeps
 * it on Alchemy local state. `test-ci`, `dev`, `prod` and `staging-<N>` all fail one of them.
 *
 * @param phase - The raw phase argument.
 * @param stage - The raw stage argument.
 * @returns The validated phase and stage, or a {@link TestStageRefused} failure.
 */
export const decideTestStage = Effect.fn("decideTestStage")(function* decideTestStage(
  phase: string,
  stage: string,
) {
  if (!isPhase(phase)) {
    return yield* new TestStageRefused({
      message: `Phase ${phase} is not allowed. Use one of: ${TEST_STAGE_PHASES.join(", ")}.`,
    });
  }

  if (!TEST_STAGE_PATTERN.test(stage)) {
    return yield* new TestStageRefused({
      message: `Stage ${stage} does not match ${String(TEST_STAGE_PATTERN)}. Only throwaway test-<slug> stages run with --yes.`,
    });
  }

  if (usesProjectState(stage)) {
    return yield* new TestStageRefused({
      message: `Stage ${stage} keeps its state in the project store, not on local state. It never runs with --yes from a laptop.`,
    });
  }

  return { phase, stage };
});
