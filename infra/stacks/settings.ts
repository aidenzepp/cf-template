import { BunHttpClient, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { declarationPlan, planWarnings, reviewerAppId } from "../src/settings/declare.ts";
import { getJson, guardAdmin, resolveRepository } from "../src/settings/repository.ts";
import { applyRest } from "../src/settings/rest.ts";
import { applyRestLabels } from "../src/settings/rest-labels.ts";
import { applyDeclaration } from "../src/settings/stack.ts";
import { detectTier, reportLine } from "../src/settings/tier.ts";

/**
 * The secret names of `GET /repos/{owner}/{name}/actions/secrets`.
 */
const SecretsResponse = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/**
 * Print the `--check` stub: the drift detector arrives in part 4 of #19.
 */
const check = Console.log("check: not implemented until part 4");

/**
 * Resolve the repository, guard on admin access, detect the tier, converge the provider resources,
 * run the REST calls the provider does not cover, and print the one report line.
 */
const apply = Effect.gen(function* applySettings() {
  const { owner, repo } = yield* resolveRepository();
  const repository = yield* guardAdmin({ owner, repo });
  const secrets = yield* getJson(`/repos/${owner}/${repo}/actions/secrets`, SecretsResponse);

  const tier = yield* detectTier(
    repository,
    secrets.secrets.map((secret) => secret.name),
  );

  const reviewer = yield* reviewerAppId;
  const warnings = planWarnings(repository, tier, reviewer);

  yield* Effect.all(warnings.map((line) => Console.warn(line)));

  const declared = yield* applyDeclaration(declarationPlan(repository, tier, reviewer));
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

const selected: Effect.Effect<void, { readonly message: string }, HttpClient.HttpClient> =
  process.argv.includes("--check") ? check : apply;

const program = selected.pipe(
  Effect.tapError((failure) => Console.error(failure.message)),
  Effect.provide(BunHttpClient.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
