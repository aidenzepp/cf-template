import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as cfD1 from "@distilled.cloud/cloudflare/d1";
import * as cfWorkers from "@distilled.cloud/cloudflare/workers";
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { CloudflarePlanKnob } from "@workspace/config/plan";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import {
  ConfigProvider,
  Console,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BOOTSTRAP_SECRETS, BOOTSTRAP_STAGE, BOOTSTRAP_VARIABLES } from "../stacks/bootstrap.ts";
import { getJson, resolveRepository } from "./settings/repository.ts";
import { resolveStackName } from "./stack-name.ts";

/**
 * A refusal or failure of the credentials half. The message names the runbook step in
 * `docs/spin-up.md` and never a token, a profile's contents or a secret value.
 */
export class CredentialsError extends Schema.TaggedError<
  CredentialsError,
  { readonly brand: unique symbol }
>()("CredentialsError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

/**
 * The failure text when no source names the stack.
 */
export const NO_STACK_NAME =
  "Set `STACK_NAME` (a-z, 0-9, hyphens, at most 29 characters) or add an `origin` remote on github.com";

/**
 * The runbook reference every prerequisite refusal ends with.
 */
const STEP_1 = "See docs/spin-up.md, Once per machine, step 1.";

/**
 * The runbook reference of the Bun pin and Workers Paid refusals.
 */
const PREREQUISITES = "See docs/spin-up.md, Prerequisites.";

/**
 * The runbook reference of a rename or re-pin.
 */
const STEP_22 = "See docs/spin-up.md, Operate, step 22.";

/**
 * The dashboard page that shows the account's Workers plan.
 */
export const PLAN_PAGE = "https://dash.cloudflare.com/?to=/:account/workers/plans";

/**
 * The Cloudflare Workers plan of the deploying account.
 */
export type Plan = "free" | "paid";

/**
 * The repository as `GET /repos/{owner}/{name}` answers it for the signed-in token.
 */
export interface RepositoryView {
  /**
   * The canonical `owner/name`.
   */
  readonly fullName: string;
  /**
   * The numeric repository id.
   */
  readonly id: number;
  /**
   * Whether the token has `permissions.admin`.
   */
  readonly admin: boolean;
}

/**
 * The repository identity frozen in the `<stack>-bootstrap` record.
 */
export const BootstrapRecord = Schema.Struct({
  repository: Schema.String,
  repositoryId: Schema.Finite,
});

/**
 * The repository identity frozen in the `<stack>-bootstrap` record.
 */
export type FrozenIdentity = typeof BootstrapRecord.Type;

/**
 * What the bootstrap deploy declares.
 */
export interface DeployInput {
  readonly stack: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly customDomain: string;
  readonly subdomain: string;
}

/**
 * The reads and writes the credentials half performs. Tests provide a fake; {@link SpinUpLive}
 * talks to Bun, `gh`'s token, the Alchemy CLI and the Cloudflare API.
 */
export class SpinUp extends Context.Service<
  SpinUp,
  {
    /**
     * The running Bun version.
     */
    readonly bunVersion: Effect.Effect<string, CredentialsError>;
    /**
     * The Bun version `packageManager` pins in `package.json`.
     */
    readonly bunPin: Effect.Effect<string, CredentialsError>;
    /**
     * The repository for the signed-in token, none when the API does not answer 200.
     */
    readonly repository: (slug: string) => Effect.Effect<Option.Option<RepositoryView>>;
    /**
     * The names of the Alchemy profiles on this machine.
     */
    readonly profiles: Effect.Effect<ReadonlyArray<string>, CredentialsError>;
    /**
     * The plan detector; a failure means it did not return an answer.
     */
    readonly detectPlan: (profile: string) => Effect.Effect<Plan, CredentialsError>;
    /**
     * The repository variables by name.
     */
    readonly variables: (
      slug: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, CredentialsError>;
    /**
     * The repository secret names.
     */
    readonly secrets: (slug: string) => Effect.Effect<ReadonlyArray<string>, CredentialsError>;
    /**
     * The account's Worker and D1 database names that start with `<stack>-`.
     */
    readonly accountNames: (
      stack: string,
      profile: string,
    ) => Effect.Effect<ReadonlyArray<string>, CredentialsError>;
    /**
     * The `<stack>-bootstrap` record in the store `<stack>-state`, none when absent.
     */
    readonly record: (
      stack: string,
      profile: string,
    ) => Effect.Effect<Option.Option<FrozenIdentity>, CredentialsError>;
    /**
     * The account's `workers.dev` subdomain.
     */
    readonly workersSubdomain: (profile: string) => Effect.Effect<string, CredentialsError>;
    /**
     * `bun run alchemy state bootstrap` for the store `<stack>-state`.
     */
    readonly stateBootstrap: (
      stack: string,
      profile: string,
    ) => Effect.Effect<void, CredentialsError>;
    /**
     * `bun run alchemy deploy` of the bootstrap stack at stage `prod`.
     */
    readonly deploy: (input: DeployInput, profile: string) => Effect.Effect<void, CredentialsError>;
  }
>()("infra/SpinUp") {}

/**
 * The Workers plan: the detector's answer when it returns one, else `CLOUDFLARE_PLAN`. The knob is
 * read only when the detector fails.
 *
 * @param profile - The profile the detector mints its token under.
 * @returns The plan.
 */
export const workersPlan = Effect.fn("workersPlan")(function* workersPlan(profile: string) {
  const spinUp = yield* SpinUp;

  return yield* spinUp.detectPlan(profile).pipe(
    Effect.catch(() =>
      CloudflarePlanKnob.config.pipe(
        Effect.mapError(
          () =>
            new CredentialsError({
              message: `CLOUDFLARE_PLAN must be free or paid. ${PREREQUISITES}`,
            }),
        ),
      ),
    ),
  );
});

/**
 * Refuse a Free account: the password hash costs about `115 ms` of CPU against the Free plan's
 * `10 ms` limit.
 *
 * @param profile - The profile the detector runs under.
 * @returns Nothing on Paid, or the refusal on Free.
 */
const requirePaid = Effect.fn("requirePaid")(function* requirePaid(profile: string) {
  const plan = yield* workersPlan(profile);

  return plan === "paid"
    ? undefined
    : yield* new CredentialsError({
        message: `The account is on Workers Free. Compare on ${PLAN_PAGE}: the Free plan allows 10 ms of CPU per request and one password hash costs about 115 ms. Upgrade to Workers Paid and run again. ${PREREQUISITES}`,
      });
});

/**
 * Refuse unless the running Bun is the `packageManager` pin, the token is an admin of the
 * repository, the `default` and the selected profile exist, and the account is on Workers Paid.
 *
 * @param slug - The repository `owner/name`.
 * @param profile - The profile the bootstrap runs under.
 * @returns The repository view, or the {@link CredentialsError} of the first refusal.
 */
export const preflight = Effect.fn("preflight")(function* preflight(slug: string, profile: string) {
  const spinUp = yield* SpinUp;
  const running = yield* spinUp.bunVersion;
  const pinned = yield* spinUp.bunPin;

  if (running !== pinned) {
    return yield* new CredentialsError({
      message: `Bun ${running} is running but package.json pins bun@${pinned}. Install Bun ${pinned} and run again. ${PREREQUISITES}`,
    });
  }

  const view = yield* spinUp.repository(slug);

  if (Option.isNone(view) || !view.value.admin) {
    return yield* new CredentialsError({
      message: `GET /repos/${slug} did not answer 200 with permissions.admin: true. Sign gh in as the repository owner (\`gh auth login\`) and run again. ${STEP_1}`,
    });
  }

  const profiles = yield* spinUp.profiles;
  const missing = ["default", profile].filter((name) => !profiles.includes(name));

  if (missing.length > 0) {
    return yield* new CredentialsError({
      message: `The Alchemy profile ${missing.map((name) => `\`${name}\``).join(" and ")} is missing. Create it with \`bun run alchemy profile create\` and \`bun run alchemy profile edit\`, then run again. ${STEP_1}`,
    });
  }

  yield* requirePaid(profile);

  return view.value;
});

/**
 * What sub-step 2 decides: the stack to use, whether to run the collision check, and the identity
 * to declare.
 */
export type PinDecision =
  | { readonly kind: "first"; readonly stack: string }
  | { readonly kind: "resume"; readonly stack: string; readonly identity: FrozenIdentity };

/**
 * Apply the re-run table to the live pin and the bootstrap record.
 *
 * Pin present with a matching id declares the frozen identity; pin present with another id
 * refuses; pin absent with a record is a hand deletion and refuses; pin absent with no record is a
 * first run. `--force` turns each refusal into a declaration of the live identity.
 *
 * @param input - The derived name, the pin, the record, the live repository and `--force`.
 * @param input.derived - The derived stack name.
 * @param input.pin - The live `STACK_NAME` variable.
 * @param input.record - The `<stack>-bootstrap` record under the pin, or under the derived name.
 * @param input.live - The repository as the API answers it.
 * @param input.force - Whether `--force` was passed.
 * @returns The decision, or the refusal naming the repair.
 */
export const decidePin = (input: {
  readonly derived: string;
  readonly pin: Option.Option<string>;
  readonly record: Option.Option<FrozenIdentity>;
  readonly live: RepositoryView;
  readonly force: boolean;
}): Effect.Effect<PinDecision, CredentialsError> => {
  const stack = Option.getOrElse(input.pin, () => input.derived);
  const live = { repository: input.live.fullName, repositoryId: input.live.id };

  if (Option.isSome(input.record)) {
    const frozen = input.record.value;

    if (frozen.repositoryId === input.live.id && Option.isSome(input.pin)) {
      return Effect.succeed({ identity: frozen, kind: "resume", stack });
    }

    if (input.force) {
      return Effect.succeed({ identity: live, kind: "resume", stack });
    }

    return Effect.fail(
      new CredentialsError({
        message: Option.isSome(input.pin)
          ? `The repository id ${input.live.id} differs from id ${frozen.repositoryId} frozen in ${stack}-bootstrap. Refusing; repair only with \`bun run credentials --profile admin --force\`. ${STEP_22}`
          : `STACK_NAME is not set on the repository but the store ${stack}-state holds a ${stack}-bootstrap record: the variable was deleted by hand. Restore it, or re-declare it with \`bun run credentials --profile admin --force\`. ${STEP_22}`,
      }),
    );
  }

  if (Option.isSome(input.pin) && !input.force) {
    return Effect.fail(
      new CredentialsError({
        message: `STACK_NAME is pinned to ${stack} but the store ${stack}-state holds no ${stack}-bootstrap record. Refusing; re-declare it with \`bun run credentials --profile admin --force\`. ${STEP_22}`,
      }),
    );
  }

  return Effect.succeed({ kind: "first", stack });
};

/**
 * The collision rule: any `<stack>-` Worker or D1 database other than the store refuses by name;
 * the store `<stack>-state` with this bootstrap's record is a resume; the store with no record
 * refuses and names the two repairs.
 *
 * @param stack - The stack name.
 * @param names - The account's Worker and D1 names with the `<stack>-` prefix.
 * @param hasRecord - Whether the store holds the `<stack>-bootstrap` record.
 * @returns `clear` or `resume`, or the refusal.
 */
export const collision = (
  stack: string,
  names: ReadonlyArray<string>,
  hasRecord: boolean,
): Effect.Effect<"clear" | "resume", CredentialsError> => {
  const store = `${stack}-state`;
  const taken = names.find((name) => name.startsWith(`${stack}-`) && name !== store);

  if (taken !== undefined) {
    return Effect.fail(
      new CredentialsError({
        message: `${taken} already exists on the account, so the stack name ${stack} collides with another project. Choose another name with STACK_NAME and run again. ${STEP_22}`,
      }),
    );
  }

  if (!names.includes(store)) {
    return Effect.succeed("clear");
  }

  return hasRecord
    ? Effect.succeed("resume")
    : Effect.fail(
        new CredentialsError({
          message: `The Worker ${store} exists but this run found no ${stack}-bootstrap record in it. Check first, from the repository root: \`STACK_NAME=${stack} bun run alchemy state list --config infra/alchemy.run.ts --profile admin\`. If it lists ${stack}-bootstrap/, the store is this project's: do not destroy it, and report the failed lookup. Only if it does not, and ${store} is a leftover of another project, destroy ${store}, which deletes every stage's state in it, or choose another name with STACK_NAME, then run again. ${STEP_22}`,
        }),
      );
};

/**
 * Whether `alchemy state list` output names the `<stack>-bootstrap` stack. A top-level listing
 * prints one stack per line with a trailing slash (`cf-template-bootstrap/`), as Alchemy's
 * `listState` returns it.
 *
 * @param stdout - The `alchemy state list` output.
 * @param stack - The stack name.
 * @returns Whether the bootstrap stack is listed.
 */
export const listsBootstrapRecord = (stdout: string, stack: string): boolean =>
  stdout.split("\n").some((line) => line.trim() === `${stack}-bootstrap/`);

/**
 * The JSON value in `alchemy state read` output for one key. The command prints the value as
 * `JSON.stringify(value, null, 2)`, a top-level `{` line through its closing `}`, but the CLI's
 * plain renderer also writes task lines (`• Refreshing Cloudflare State Store credentials`, then
 * `✓ ...`) and, outside JSON log format, log records to stdout first. This keeps the text from the
 * last line that is exactly `{`.
 *
 * @param stdout - The `alchemy state read` output.
 * @returns The JSON text, or the whole output when no line is `{`.
 */
export const stateReadJson = (stdout: string): string => {
  const lines = stdout.split("\n");
  const start = lines.lastIndexOf("{");

  return start === -1 ? stdout : lines.slice(start).join("\n");
};

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
  const secrets = yield* spinUp.secrets(slug);

  const missing = [
    ...BOOTSTRAP_VARIABLES.filter((name) => !variables.has(name)),
    ...BOOTSTRAP_SECRETS.filter((name) => !secrets.includes(name)),
  ];

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
 * @param options - The command-line options.
 * @param options.profile - The profile the whole bootstrap runs under, `admin` by convention.
 * @param options.force - Whether `--force` repairs a refused pin or record.
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

  yield* spinUp.deploy(
    {
      customDomain: variables.get("CUSTOM_DOMAIN") ?? "workers-dev",
      repository: identity.repository,
      repositoryId: identity.repositoryId,
      stack: decision.stack,
      subdomain: yield* spinUp.workersSubdomain(options.profile),
    },
    options.profile,
  );

  yield* readBack(slug);
});

/**
 * Wrap a failed step as a {@link CredentialsError} naming its tag and message, never its request.
 *
 * @param step - What failed.
 * @returns The mapper.
 */
const failed =
  (step: string) =>
  (cause: unknown): CredentialsError =>
    new CredentialsError({
      cause,
      message: `${step} failed${Predicate.hasProperty(cause, "_tag") ? ` (${String(cause._tag)})` : ""}. If the admin token expired, re-mint it with \`bun run alchemy profile edit --profile admin\` and run again. ${STEP_1}`,
    });

/**
 * The permission-group id of Billing Read, the detector token's only permission.
 */
const BILLING_READ = Cloudflare.ApiToken.PERMISSION_GROUPS_BY_NAME["Billing Read"].id;

/**
 * Read the Workers plan from the account's subscriptions (**unverified**: whether the Paid plan
 * appears there and under which rate plan). A subscription whose rate plan names Workers decides;
 * none deciding is no answer.
 *
 * @param items - The subscriptions.
 * @returns The plan, or none.
 */
export const planOf = (
  items: ReadonlyArray<{
    readonly price?: number | null;
    readonly ratePlan?: { readonly id?: string | null; readonly publicName?: string | null } | null;
  }>,
): Option.Option<Plan> => {
  const workers = items.find((item) =>
    `${item.ratePlan?.id ?? ""} ${item.ratePlan?.publicName ?? ""}`
      .toLowerCase()
      .includes("workers"),
  );

  if (workers === undefined) {
    return Option.none();
  }

  const name = `${workers.ratePlan?.id ?? ""} ${workers.ratePlan?.publicName ?? ""}`.toLowerCase();

  return Option.some(name.includes("free") || (workers.price ?? 0) === 0 ? "free" : "paid");
};

/**
 * The fields of `GET /repos/{owner}/{name}` the preflight reads.
 */
const RepositoryResponse = Schema.Struct({
  full_name: Schema.String,
  id: Schema.Finite,
  permissions: Schema.optional(Schema.Struct({ admin: Schema.Boolean })),
});

/**
 * The fields of `GET /repos/{owner}/{name}/actions/variables`.
 */
const VariablesResponse = Schema.Struct({
  variables: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});

/**
 * The fields of `GET /repos/{owner}/{name}/actions/secrets`.
 */
const SecretsResponse = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/**
 * The `packageManager` field of `package.json`.
 */
const PackageManifest = Schema.fromJsonString(Schema.Struct({ packageManager: Schema.String }));

/**
 * Run `bun run alchemy` with `STACK_NAME` and the extra environment, capturing stdout. It sets
 * `ALCHEMY_LOG_FORMAT=json`, which sends Alchemy's log records to stderr; the pretty format writes
 * them to stdout, ahead of the command's own output.
 *
 * @param args - The arguments after `alchemy`.
 * @param env - The extra environment.
 * @returns The exit code and stdout.
 */
const alchemy = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* runAlchemy() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", ["run", "alchemy", ...args], {
          env: { ...env, ALCHEMY_LOG_FORMAT: "json" },
          extendEnv: true,
          stderr: "inherit",
        }),
      );

      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );

      return { exitCode: Number(exitCode), stdout };
    }),
  );

/**
 * Run `bun run alchemy` with the terminal attached, failing on a non-zero exit.
 *
 * @param step - The step name for the failure.
 * @param args - The arguments after `alchemy`.
 * @param env - The extra environment.
 * @returns Nothing, or the failure.
 */
const alchemyAttached = (step: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* runAttached() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make("bun", ["run", "alchemy", ...args], {
          env,
          extendEnv: true,
          stderr: "inherit",
          stdin: "inherit",
          stdout: "inherit",
        }),
      )
      .pipe(Effect.mapError(failed(step)));

    return Number(exitCode) === 0
      ? undefined
      : yield* new CredentialsError({
          message: `${step} exited ${Number(exitCode)}. Fix the error above and run again; a re-run resumes.`,
        });
  });

/**
 * The services Alchemy's authenticated Cloudflare layer provides.
 */
type CloudflareContext = Layer.Success<ReturnType<typeof CloudflareApiLive>>;

/**
 * The real reads and writes: Bun, the GitHub API with `GITHUB_TOKEN`, the Alchemy CLI through the
 * root `alchemy` script, and the Cloudflare API through Alchemy's authenticated layer under the
 * selected profile. It never reads, parses or prints a profile, a token or a secret value.
 */
export const SpinUpLive = Layer.effect(
  SpinUp,
  Effect.gen(function* buildSpinUp() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const http = yield* Effect.context<HttpClient.HttpClient>();

    const github = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, step: string) =>
      effect.pipe(Effect.provideContext(http), Effect.mapError(failed(step)));

    const cloudflare = <A, E>(
      profile: string,
      step: string,
      run: (accountId: string) => Effect.Effect<A, E, CloudflareContext>,
    ): Effect.Effect<A, CredentialsError> => {
      const provider = ConfigProvider.orElse(
        ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: profile }),
        ConfigProvider.fromEnv(),
      );

      return Effect.scoped(
        Effect.gen(function* callCloudflare() {
          const context = yield* Layer.build(
            Layer.provide(
              CloudflareApiLive(),
              Layer.mergeAll(BunServices.layer, AuthProvidersLive, FetchHttpClient.layer),
            ),
          );

          return yield* Cloudflare.CloudflareEnvironment.current.pipe(
            Effect.flatMap((environment) => run(environment.accountId)),
            Effect.provideContext(context),
          );
        }),
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.mapError(failed(step)),
      );
    };

    return SpinUp.of({
      accountNames: (stack, profile) =>
        cloudflare(profile, "Listing the account's Workers and D1 databases", (accountId) =>
          Effect.all({
            databases: cfD1.listDatabases.items({ accountId }).pipe(
              Stream.map((db) => db.name ?? ""),
              Stream.runCollect,
            ),
            workers: cfWorkers.listScripts.items({ accountId }).pipe(
              Stream.map((script) => script.id ?? ""),
              Stream.runCollect,
            ),
          }).pipe(
            Effect.map(({ databases, workers }) =>
              [...workers, ...databases].filter((name) => name.startsWith(`${stack}-`)),
            ),
          ),
        ),

      bunPin: fs.readFileString("package.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest)),
        Effect.map((manifest) => manifest.packageManager.replace(/^bun@/u, "")),
        Effect.mapError(failed("Reading packageManager from package.json")),
      ),

      bunVersion: spawner.string(ChildProcess.make("bun", ["--version"])).pipe(
        Effect.map((text) => text.trim()),
        Effect.mapError(failed("Running bun --version")),
      ),

      deploy: (input, profile) =>
        alchemyAttached(
          "bun run alchemy deploy --config infra/stacks/bootstrap.ts",
          [
            "deploy",
            "--config",
            "infra/stacks/bootstrap.ts",
            "--profile",
            profile,
            "--stage",
            BOOTSTRAP_STAGE,
            "--yes",
          ],
          {
            BOOTSTRAP_CUSTOM_DOMAIN: input.customDomain,
            BOOTSTRAP_REPOSITORY: input.repository,
            BOOTSTRAP_REPOSITORY_ID: String(input.repositoryId),
            CLOUDFLARE_WORKERS_SUBDOMAIN: input.subdomain,
            STACK_NAME: input.stack,
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),

      detectPlan: (profile) =>
        cloudflare(profile, "The Workers plan detector", (accountId) =>
          Effect.gen(function* detect() {
            const expires = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 }));

            const minted = yield* cfAccounts.createToken({
              accountId,
              expiresOn: expires,
              name: "plan-detector",
              policies: [
                {
                  effect: "allow",
                  permissionGroups: [{ id: BILLING_READ }],
                  resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                },
              ],
            });

            const tokenId = minted.id ?? "";

            const subscriptions = cfAccounts.getSubscription
              .items({ accountId })
              .pipe(
                Stream.runCollect,
                Effect.provide(fromApiToken({ apiToken: Redacted.make(minted.value ?? "") })),
              );

            const items = yield* subscriptions.pipe(
              Effect.ensuring(cfAccounts.deleteToken({ accountId, tokenId }).pipe(Effect.ignore)),
            );

            const plan = planOf(items);

            if (Option.isNone(plan)) {
              return yield* new CredentialsError({
                message: "The subscriptions list holds no Workers rate plan.",
              });
            }

            return plan.value;
          }),
        ),

      profiles: alchemy(["profile", "list"], {}).pipe(
        Effect.map(({ stdout }) =>
          stdout.split("\n").flatMap((line) => {
            const name = /^[*-] (?<name>[^:\s]+)/u.exec(line.trim())?.groups?.name;

            return name === undefined ? [] : [name];
          }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(failed("Listing the Alchemy profiles")),
      ),

      record: (stack, profile) =>
        Effect.gen(function* readRecord() {
          const env = { STACK_NAME: stack };
          const config = ["--config", "infra/alchemy.run.ts", "--profile", profile];
          const listed = yield* alchemy(["state", "list", ...config], env);

          if (!listsBootstrapRecord(listed.stdout, stack)) {
            return Option.none<FrozenIdentity>();
          }

          const read = yield* alchemy(
            ["state", "read", `${stack}-bootstrap/${BOOTSTRAP_STAGE}/output`, ...config],
            env,
          );

          return Option.some(
            yield* Schema.decodeEffect(Schema.fromJsonString(BootstrapRecord))(
              stateReadJson(read.stdout),
            ),
          );
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(failed(`Reading the ${stack}-bootstrap record`)),
        ),

      repository: (slug) =>
        github(getJson(`/repos/${slug}`, RepositoryResponse), `GET /repos/${slug}`).pipe(
          Effect.map((body) =>
            Option.some({
              admin: body.permissions?.admin === true,
              fullName: body.full_name,
              id: body.id,
            }),
          ),
          Effect.orElseSucceed(() => Option.none<RepositoryView>()),
        ),

      secrets: (slug) =>
        github(
          getJson(`/repos/${slug}/actions/secrets?per_page=100`, SecretsResponse),
          `GET /repos/${slug}/actions/secrets`,
        ).pipe(Effect.map((body) => body.secrets.map((secret) => secret.name))),

      stateBootstrap: (stack, profile) =>
        alchemyAttached(
          "bun run alchemy state bootstrap",
          ["state", "bootstrap", "--config", "infra/alchemy.run.ts", "--profile", profile],
          { STACK_NAME: stack },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),

      variables: (slug) =>
        github(
          getJson(`/repos/${slug}/actions/variables?per_page=100`, VariablesResponse),
          `GET /repos/${slug}/actions/variables`,
        ).pipe(
          Effect.map((body) => new Map(body.variables.map((entry) => [entry.name, entry.value]))),
        ),

      workersSubdomain: (profile) =>
        cloudflare(profile, "Reading the workers.dev subdomain", (accountId) =>
          cfWorkers.getSubdomain({ accountId }).pipe(Effect.map((body) => body.subdomain)),
        ),
    });
  }),
);

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
