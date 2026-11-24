import type { Effect, Option } from "effect";
import { Context, Predicate, Schema } from "effect";
import type {
  DeployInput,
  FrozenIdentity,
  Plan,
  ReadProbe,
  RepositoryView,
} from "./credentials-types.ts";

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
export const STEP_1 = "See docs/spin-up.md, Once per machine, step 1.";

/**
 * Wrap a failed step as a {@link CredentialsError} naming its tag and message, never its request.
 *
 * @param step - What failed.
 * @returns The mapper.
 */
export const failed =
  (step: string) =>
  (cause: unknown): CredentialsError =>
    new CredentialsError({
      cause,
      message: `${step} failed${Predicate.hasProperty(cause, "_tag") ? ` (${String(cause._tag)})` : ""}. If the admin token expired, re-mint it with \`bun run alchemy profile edit --profile admin\` and run again. ${STEP_1}`,
    });

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
     * Whether the admin token can read one account resource the bootstrap lists: false when
     * Cloudflare answers Unauthorized or Forbidden, a failure for any other error.
     */
    readonly canRead: (
      profile: string,
      group: ReadProbe,
    ) => Effect.Effect<boolean, CredentialsError>;
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
     * `bun run alchemy deploy` of the bootstrap stack at stage `prod`, with Alchemy's `--force`
     * when `force` is true.
     *
     * Alchemy plans an unchanged GitHub variable as a no-op and never asks GitHub whether it still
     * exists, so only a forced deploy recreates one deleted by hand.
     */
    readonly deploy: (
      input: DeployInput,
      profile: string,
      force: boolean,
    ) => Effect.Effect<void, CredentialsError>;
  }
>()("infra/SpinUp") {}
