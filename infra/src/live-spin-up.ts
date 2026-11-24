import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as cfD1 from "@distilled.cloud/cloudflare/d1";
import * as cfSecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as cfWorkers from "@distilled.cloud/cloudflare/workers";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import {
  ConfigProvider,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BOOTSTRAP_STAGE } from "../stacks/bootstrap-names.ts";
import { BootstrapRecord } from "./credentials-types.ts";
import type { FrozenIdentity, RepositoryView } from "./credentials-types.ts";
import { PROBES, planOf } from "./preflight.ts";
import { getJson } from "./settings/repository.ts";
import { CredentialsError, SpinUp, failed } from "./spin-up.ts";
import { listsBootstrapRecord, stateReadJson } from "./stack-pin.ts";

/**
 * The permission-group id of Billing Read, the detector token's only permission.
 */
const BILLING_READ = Cloudflare.ApiToken.PERMISSION_GROUPS_BY_NAME["Billing Read"].id;

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
 * Run a Cloudflare call under the selected profile, in Alchemy's authenticated layer.
 *
 * @param profile - The Alchemy profile the call runs under.
 * @param step - What the call does, for the failure message.
 * @param run - The call, given the account id.
 * @returns The call's result, or the failure naming the step.
 */
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

      canRead: (profile, group) =>
        cloudflare(profile, `Listing the account's ${PROBES[group].lists}`, (accountId) => {
          const denied = {
            Forbidden: () => Effect.succeed(false),
            Unauthorized: () => Effect.succeed(false),
          };

          const probes = {
            d1: cfD1.listDatabases
              .items({ accountId })
              .pipe(Stream.runHead, Effect.as(true), Effect.catchTags(denied)),
            "secrets-store": cfSecretsStore.listStores
              .items({ accountId })
              .pipe(Stream.runHead, Effect.as(true), Effect.catchTags(denied)),
            workers: cfWorkers.listScripts
              .items({ accountId })
              .pipe(Stream.runHead, Effect.as(true), Effect.catchTags(denied)),
          };

          return probes[group];
        }),

      deploy: (input, profile, force) =>
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
            ...(force ? ["--force"] : []),
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
