import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemist from "alchemy/Alchemist";
import { Effect } from "effect";
import type { DeclarationPlan } from "./declare.ts";

/**
 * The fixed stage of the settings stack. The stack is stateless, so the stage only names the run.
 */
const STAGE = "settings";

/**
 * Declare every resource of the plan through the `@alchemy.run/github` provider.
 *
 * Each resource id is its GitHub name, so renaming a label, environment or variable replaces it.
 * The `main` ruleset opts into `adopt(true)`: the provider treats a same-named ruleset as foreign
 * until then, and the declaration rewrites it in place.
 *
 * @param plan - The declaration the tier allows.
 * @returns The stack program; it has no outputs.
 */
const declare = (plan: DeclarationPlan) =>
  Effect.gen(function* declareResources() {
    yield* GitHub.Repository("repository", plan.repository);

    yield* Effect.all(
      plan.ruleset.map((props) => GitHub.Ruleset(props.name, props).pipe(adopt(true))),
    );

    yield* Effect.all(plan.environments.map((props) => GitHub.Environment(props.name, props)));
    yield* Effect.all(plan.labels.map((props) => GitHub.Label(props.name, props)));
    yield* Effect.all(plan.variables.map((props) => GitHub.Variable(props.name, props)));

    return {};
  });

/**
 * Converge the GitHub provider resources of a plan: the settings stack on `inMemoryState()`.
 *
 * The provider resolves its token from `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` in the environment,
 * the same `GITHUB_TOKEN` the REST step reads. The state lives in memory, so every run is a full
 * converge and nothing is written to a state store. The ambient Alchemy services come from
 * `Alchemist.layer()`.
 *
 * @param plan - The declaration the tier allows.
 * @returns The number of provider resources converged.
 */
export const applyDeclaration = (plan: DeclarationPlan) =>
  Effect.gen(function* applyStack() {
    const planned = yield* Alchemist.plan({
      operation: "deploy",
      stack: Alchemy.Stack(
        "settings",
        { providers: GitHub.providers(), state: Alchemy.inMemoryState() },
        declare(plan),
      ),
      stage: STAGE,
    });

    yield* Alchemist.apply(planned);

    return planned.resources.length;
  }).pipe(Effect.scoped, Effect.provide(Alchemist.layer()));
