import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemist from "alchemy/Alchemist";
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import type { DeclarationPlan } from "./declare.ts";

/**
 * The fixed stage of the settings stack. The stack is stateless, so the stage only names the run.
 */
const STAGE = "settings";

/**
 * Replace the `Credentials` a provider layer resolves with a fixed token on github.com. The later
 * layer in a merge wins, so every provider call uses `token`.
 *
 * @param layer - The layer that provides `Credentials`.
 * @param token - The token every call must use.
 * @returns The layer with `Credentials` pinned to the token.
 */
export const withToken = <A, E, R>(layer: Layer.Layer<A, E, R>, token: Redacted.Redacted) =>
  Layer.mergeAll(layer, GitHub.fromToken(token));

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

    yield* Effect.forEach(
      plan.ruleset,
      (props) => GitHub.Ruleset(props.name, props).pipe(adopt(true)),
      { discard: true },
    );

    yield* Effect.forEach(plan.environments, (props) => GitHub.Environment(props.name, props), {
      discard: true,
    });
    yield* Effect.forEach(plan.labels, (props) => GitHub.Label(props.name, props), {
      discard: true,
    });
    yield* Effect.forEach(plan.variables, (props) => GitHub.Variable(props.name, props), {
      discard: true,
    });

    return {};
  });

/**
 * Converge the GitHub provider resources of a plan: the settings stack on `inMemoryState()`.
 *
 * The provider authenticates with the token it is given, the one the admin guard checked, not with
 * whatever it would resolve from the environment or the Alchemy profile. The state lives in
 * memory, so every run is a full converge and nothing is written to a state store. The ambient
 * Alchemy services come from `Alchemist.layer()`.
 *
 * @param plan - The declaration the tier allows.
 * @param token - The guarded token.
 * @returns The number of provider resources converged.
 */
export const applyDeclaration = (plan: DeclarationPlan, token: Redacted.Redacted) =>
  Effect.gen(function* applyStack() {
    const planned = yield* Alchemist.plan({
      operation: "deploy",
      stack: Alchemy.Stack(
        "settings",
        { providers: withToken(GitHub.providers(), token), state: Alchemy.inMemoryState() },
        declare(plan),
      ),
      stage: STAGE,
    });

    yield* Alchemist.apply(planned);

    return planned.resources.length;
  }).pipe(Effect.scoped, Effect.provide(Alchemist.layer()));
