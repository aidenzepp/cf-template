import { BunHttpClient, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import {
  GitHubProviderMissing,
  MISSING_GITHUB_RESOURCES,
  declarationPlan,
  planWarnings,
  reviewerAppId,
} from "../src/settings/declare.ts";
import { getJson, guardAdmin, resolveRepository } from "../src/settings/repository.ts";
import { detectTier } from "../src/settings/tier.ts";

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
 * Resolve the repository, guard on admin access, detect the tier and build the declaration.
 *
 * TODO: apply the plan with `GitHub.*` resources under `Alchemy.inMemoryState()` and
 * `GitHub.fromToken(token)`, then print `reportLine`. The pinned Alchemy has no GitHub provider,
 * so the run stops after planning and writes nothing.
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
  const plan = declarationPlan(repository, tier, reviewer);

  yield* Effect.forEach(planWarnings(repository, tier, reviewer), (line) => Console.warn(line));

  return yield* new GitHubProviderMissing({
    message: `Planned ${plan.length} declarations for ${owner}/${repo} but applied none: the pinned Alchemy has no ${MISSING_GITHUB_RESOURCES.join(", ")}.`,
  });
});

const selected: Effect.Effect<void, { readonly message: string }, HttpClient.HttpClient> =
  process.argv.includes("--check") ? check : apply;

const program = selected.pipe(
  Effect.tapError((failure) => Console.error(failure.message)),
  Effect.provide(BunHttpClient.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
