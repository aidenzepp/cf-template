import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";

/**
 * The fixed stage of the bootstrap stack. It is this file's own literal: the stack never imports or
 * decodes the app stage Schema of `infra/stages.ts`, so the app stack's `prod` refusal does not
 * apply here.
 */
export const BOOTSTRAP_STAGE = "prod";

/**
 * The permission groups of the scoped CI token, by their names in Alchemy's permission-group
 * catalog: every group the `app` stack's `prod` and `test` stages need, one reason each. A custom
 * domain (`CUSTOM_DOMAIN`, docs/spin-up.md step 14) adds zone resources and needs zone-scoped
 * groups this account-scoped list does not hold.
 */
export const CI_TOKEN_PERMISSION_GROUPS = [
  // Every Worker upload: api, auth, web, the guard and the state store, with their Durable
  // Objects, static assets, rate-limit bindings, Telemetry settings and workers.dev subdomain.
  "Workers Scripts Write",
  // The D1 databases and their migrations.
  "D1 Write",
  // Binding Secrets Store secrets, and the state store's token read (environments/ci.mdx:466-476).
  "Secrets Store Write",
  // Account lookups during deploy.
  "Account Settings Read",
  // Reading Worker tails.
  "Workers Tail Read",
  // The KV namespaces.
  "Workers KV Storage Write",
  // The NotificationPolicy and each CustomAlert's notification policy (alerting.createPolicy).
  "Notifications Write",
  // The SQL API that validates each CustomAlert query
  // (developers.cloudflare.com/analytics/sql-api/get-started/).
  "Account Analytics Read",
  // The Workers Logs dataset those queries read, and IssueAutomation
  // (workers.createObservabilityIssueAutomation).
  "Workers Observability Write",
] as const satisfies ReadonlyArray<Cloudflare.ApiToken.PermissionGroupName>;

/**
 * The repository secrets the bootstrap stack writes.
 */
export const BOOTSTRAP_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/**
 * The repository variables the bootstrap stack writes.
 */
export const BOOTSTRAP_VARIABLES = [
  "STACK_NAME",
  "CUSTOM_DOMAIN",
  "CLOUDFLARE_DEPLOYS",
  "CLOUDFLARE_WORKERS_SUBDOMAIN",
] as const;

/**
 * A stack name: lower case letters, digits and `-`, 3 to 29 characters, starting and ending with a
 * letter or digit. The bound is restated here so the stack imports nothing from `infra/stages.ts`.
 */
const StackName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,27}[a-z0-9]$/u));

/**
 * A canonical `owner/name` repository reference.
 */
const RepositorySlug = Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/u));

/**
 * The inputs the credentials program passes to the deploy, read through `Config`: the stack name,
 * the frozen repository identity, the `CUSTOM_DOMAIN` value to declare and the account's
 * `workers.dev` subdomain.
 */
export const bootstrapInputs = Config.all({
  customDomain: Config.String("BOOTSTRAP_CUSTOM_DOMAIN").pipe(Config.withDefault("workers-dev")),
  repository: Config.schema(RepositorySlug, "BOOTSTRAP_REPOSITORY"),
  repositoryId: Config.Int("BOOTSTRAP_REPOSITORY_ID"),
  stack: Config.schema(StackName, "STACK_NAME"),
  subdomain: Config.NonEmptyString("CLOUDFLARE_WORKERS_SUBDOMAIN"),
});

/**
 * The policies of the scoped CI token: allow the permission groups on the deploying account.
 *
 * @param accountId - The deploying account's id.
 * @returns The token policies.
 */
export const ciTokenPolicies = (accountId: string) => [
  {
    effect: "allow" as const,
    permissionGroups: [...CI_TOKEN_PERMISSION_GROUPS],
    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
  },
];

/**
 * Declare the scoped CI token and the repository secrets and variables, and return the frozen
 * repository identity as the stack output.
 *
 * Every logical id is fixed, so a re-run reconciles in place: the token keeps its id and value,
 * the secrets re-upload and the variables are a no-op or a patch. Alchemy plans an unchanged
 * variable as a no-op without asking GitHub whether it still exists, so `bun run credentials`
 * forces the deploy when a value it writes is missing on the repository.
 */
const program = Effect.gen(function* declareBootstrap() {
  const inputs = yield* bootstrapInputs;
  const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
  const [owner = "", repository = ""] = inputs.repository.split("/");
  const target = { owner, repository };

  const token = yield* Cloudflare.ApiToken.AccountApiToken("ci-token", {
    accountId,
    name: `${inputs.stack}-ci`,
    policies: ciTokenPolicies(accountId),
  });

  yield* GitHub.Secret("CLOUDFLARE_API_TOKEN", {
    ...target,
    name: "CLOUDFLARE_API_TOKEN",
    value: token.value,
  });

  yield* GitHub.Secret("CLOUDFLARE_ACCOUNT_ID", {
    ...target,
    name: "CLOUDFLARE_ACCOUNT_ID",
    value: Redacted.make(accountId),
  });

  const values: Record<(typeof BOOTSTRAP_VARIABLES)[number], string> = {
    CLOUDFLARE_DEPLOYS: "true",
    CLOUDFLARE_WORKERS_SUBDOMAIN: inputs.subdomain,
    CUSTOM_DOMAIN: inputs.customDomain,
    STACK_NAME: inputs.stack,
  };

  yield* Effect.forEach(
    BOOTSTRAP_VARIABLES,
    (name) => GitHub.Variable(name, { ...target, name, value: values[name] }),
    { discard: true },
  );

  return { repository: inputs.repository, repositoryId: inputs.repositoryId };
});

/**
 * The project's own state store, `<stack>-state`, never the account's shared store.
 */
const state = Layer.unwrap(
  Effect.gen(function* declareState() {
    const inputs = yield* bootstrapInputs;

    return Cloudflare.state({ workerName: `${inputs.stack}-state` });
  }).pipe(Effect.orDie),
);

/**
 * The host environment's `STACK_NAME`, decoded. Alchemy takes the stack name as a string when the
 * module loads, before any `Config` runs; this directory has no Node types, so the environment is
 * decoded from `globalThis` through Schema.
 */
const HostEnvironment = Schema.Struct({
  process: Schema.Struct({ env: Schema.Struct({ STACK_NAME: StackName }) }),
});

/**
 * The `<stack>-bootstrap` stack name. An unset or invalid `STACK_NAME` names the stack
 * `bootstrap`, and {@link bootstrapInputs} then fails the deploy with the `Config` error before any
 * resource is planned.
 */
const stackName = Option.match(Schema.decodeUnknownOption(HostEnvironment)(globalThis), {
  onNone: () => "bootstrap",
  onSome: (host) => `${host.process.env.STACK_NAME}-bootstrap`,
});

export default Alchemy.Stack(
  stackName,
  { providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()), state },
  program,
);
