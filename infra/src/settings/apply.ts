import { Console, Effect, Schema } from "effect";
import type { Redacted } from "effect";
import { declarationPlan, planWarnings, reviewerAppId } from "./declare.ts";
import type { DeclarationPlan } from "./declare.ts";
import {
  getJson,
  githubToken,
  guardAdmin,
  refuseAmbientCredentials,
  resolveRepository,
} from "./repository.ts";
import { applyRest } from "./rest.ts";
import { applyRestLabels } from "./rest-labels.ts";
import { detectTier, reportLine } from "./tier.ts";

/**
 * The secret names of `GET /repos/{owner}/{name}/actions/secrets`.
 */
const SecretsResponse = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/**
 * Converge the provider resources of a plan with a token, returning how many were converged.
 */
export type Declare<E, R> = (
  plan: DeclarationPlan,
  token: Redacted.Redacted,
) => Effect.Effect<number, E, R>;

/**
 * Refuse ambient provider credentials, resolve the repository, guard on admin access, detect the
 * tier, converge the provider resources with the guarded token, run the REST calls the provider
 * does not cover, and print the one report line. Nothing is written before the guard passes.
 *
 * @param declare - Converges the provider resources; the real one is `applyDeclaration`.
 * @returns The run.
 */
export const applySettings = <E, R>(declare: Declare<E, R>) =>
  Effect.gen(function* settingsRun() {
    yield* refuseAmbientCredentials();

    const { owner, repo } = yield* resolveRepository();
    const repository = yield* guardAdmin({ owner, repo });
    const token = yield* githubToken;
    const secrets = yield* getJson(`/repos/${owner}/${repo}/actions/secrets`, SecretsResponse);

    const tier = yield* detectTier(
      repository,
      secrets.secrets.map((secret) => secret.name),
    );

    const reviewer = yield* reviewerAppId;
    const warnings = planWarnings(repository, tier, reviewer);

    yield* Effect.all(warnings.map((line) => Console.warn(line)));

    const declared = yield* declare(declarationPlan(repository, tier, reviewer), token);
    const rest = yield* applyRest(repository, tier);
    const labels = yield* applyRestLabels(repository, tier);

    yield* Console.log(
      reportLine(
        tier,
        declared + rest.applied + labels.applied,
        warnings.length + rest.unavailable + labels.unavailable,
      ),
    );
  });
