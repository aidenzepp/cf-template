#!/usr/bin/env bun
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Option } from "effect";
import { BOOTSTRAP_SECRETS, BOOTSTRAP_VARIABLES } from "../stacks/bootstrap.ts";
import { collision, decidePin } from "./credentials/pin.ts";
import { permissionPreflight, preflight } from "./credentials/preflight.ts";
import { CredentialsError, NO_STACK_NAME } from "./credentials/model.ts";
import type { FrozenIdentity } from "./credentials/model.ts";
import { SpinUp } from "./credentials/spin-up.ts";
import { SpinUpLive } from "./credentials/spin-up-live.ts";
import { resolveRepository } from "./settings/repository.ts";
import { resolveStackName } from "./stack-name.ts";

/**
 * The variables and secrets this half writes that the repository does not have.
 *
 * @param variables - The repository's variables by name.
 * @param secrets - The repository's secret names.
 * @returns The missing names, variables first.
 */
const missingValues = (variables: ReadonlyMap<string, string>, secrets: ReadonlyArray<string>) => [
  ...BOOTSTRAP_VARIABLES.filter((name) => !variables.has(name)),
  ...BOOTSTRAP_SECRETS.filter((name) => !secrets.includes(name)),
];

/**
 * Fail unless the four variables and two secrets this half writes are present, and print one line
 * per variable. The tier variables are `bun run settings`'s writes and are not read here.
 *
 * @param slug - The repository `owner/name`.
 * @returns Nothing, or the failure naming the missing values.
 */
export const readBack = Effect.fn("readBack")(function* readBack(slug: string) {
  const spinUp = yield* SpinUp;
  const variables = yield* spinUp.variables(slug);
  const missing = missingValues(variables, yield* spinUp.secrets(slug));

  if (missing.length > 0) {
    return yield* new CredentialsError({
      message: `Read back failed: ${missing.join(", ")} missing on ${slug}. Run \`bun run credentials --profile admin\` again. See docs/spin-up.md, step 7.`,
    });
  }

  yield* Effect.forEach(
    BOOTSTRAP_VARIABLES,
    (name) => Console.log(`${name}=${variables.get(name) ?? ""}`),
    { discard: true },
  );

  return yield* Effect.forEach(BOOTSTRAP_SECRETS, (name) => Console.log(`${name} (secret, set)`), {
    discard: true,
  });
});

/**
 * The credentials half, in order: derive the stack name, preflight, read the pin, check for
 * collisions on a first run, bootstrap the store, deploy the bootstrap stack and read back.
 *
 * The deploy is forced under `--force`, and whenever a variable or secret this half writes is
 * missing on the repository, so a value deleted by hand is recreated rather than planned as a
 * no-op.
 *
 * @param options - The command-line options.
 * @param options.profile - The profile the whole bootstrap runs under, `admin` by convention.
 * @param options.force - Whether `--force` repairs a refused pin or record and forces the deploy.
 * @returns The run.
 */
export const credentials = Effect.fn("credentials")(function* credentials(options: {
  readonly profile: string;
  readonly force: boolean;
}) {
  const derived = yield* resolveStackName().pipe(
    Effect.mapError(
      (failure) => new CredentialsError({ message: `${NO_STACK_NAME}. ${failure.message}` }),
    ),
  );

  const { owner, repo } = yield* resolveRepository().pipe(
    Effect.mapError(
      (failure) =>
        new CredentialsError({
          cause: failure,
          message: `Cannot resolve the repository for the read-back and the preflight. ${NO_STACK_NAME}.`,
        }),
    ),
  );

  const slug = `${owner}/${repo}`;
  const live = yield* preflight(slug, options.profile);
  const spinUp = yield* SpinUp;
  const variables = yield* spinUp.variables(slug);
  const pin = Option.fromNullishOr(variables.get("STACK_NAME"));
  const stack = Option.getOrElse(pin, () => derived);
  yield* permissionPreflight(options.profile);

  const names = yield* spinUp.accountNames(stack, options.profile);

  const record = names.includes(`${stack}-state`)
    ? yield* spinUp.record(stack, options.profile)
    : Option.none<FrozenIdentity>();

  const decision = yield* decidePin({ derived, force: options.force, live, pin, record });

  if (decision.kind === "first") {
    yield* collision(decision.stack, names, false);
  }

  const identity =
    decision.kind === "resume"
      ? decision.identity
      : { repository: live.fullName, repositoryId: live.id };

  yield* Console.log(
    `stack: ${decision.stack} (${decision.kind === "resume" ? "re-run" : "first run"})`,
  );
  yield* spinUp.stateBootstrap(decision.stack, options.profile);

  const missing = missingValues(variables, yield* spinUp.secrets(slug));
  const force = options.force || missing.length > 0;

  if (missing.length > 0) {
    yield* Console.log(`missing on ${slug}: ${missing.join(", ")}; forcing the bootstrap deploy`);
  }

  yield* spinUp.deploy(
    {
      customDomain: variables.get("CUSTOM_DOMAIN") ?? "workers-dev",
      repository: identity.repository,
      repositoryId: identity.repositoryId,
      stack: decision.stack,
      subdomain: yield* spinUp.workersSubdomain(options.profile),
    },
    options.profile,
    force,
  );

  yield* readBack(slug);
});

/**
 * The command-line options: `--profile <name>` (default `admin`) and `--force`.
 *
 * @param argv - The arguments after the script.
 * @returns The options.
 */
export const parseArguments = (argv: ReadonlyArray<string>) => {
  const index = argv.indexOf("--profile");

  return {
    force: argv.includes("--force"),
    profile: (index === -1 ? undefined : argv[index + 1]) ?? "admin",
  };
};

if (import.meta.main) {
  const program = credentials(parseArguments(process.argv.slice(2))).pipe(
    Effect.tapError((failure) => Console.error(failure.message)),
    Effect.provide(SpinUpLive),
    Effect.provide([BunServices.layer, BunHttpClient.layer]),
  );

  BunRuntime.runMain(program, { disableErrorReporting: true });
}
