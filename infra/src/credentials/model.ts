import { Predicate, Schema } from "effect";

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
 * The runbook reference of the Bun pin and Workers Paid refusals.
 */
export const PREREQUISITES = "See docs/spin-up.md, Prerequisites.";

/**
 * The runbook reference of a rename or re-pin.
 */
export const STEP_22 = "See docs/spin-up.md, Operate, step 22.";

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
 * The account reads the admin token is probed with before the first write: Workers scripts, D1
 * databases and Secrets Store stores.
 */
export type ReadProbe = "workers" | "d1" | "secrets-store";

/**
 * What each probe lists, the permission group the token lacks when it is denied, and the Edit
 * group the step needs. Edit cannot be probed without writing, so the message names it.
 */
export const PROBES: Record<ReadProbe, { readonly lists: string; readonly missing: string }> = {
  d1: {
    lists: "D1 databases",
    missing: "D1 Read (the collision check lists databases)",
  },
  "secrets-store": {
    lists: "Secrets Store stores",
    missing: "Secrets Store Edit (the state store's default store and auth-token secret)",
  },
  workers: {
    lists: "Workers scripts",
    missing:
      "Workers Scripts Edit (the collision check, the workers.dev subdomain, and the state store's Worker upload, Durable Object namespace and subdomain)",
  },
};

/**
 * Wrap a failed step as a {@link CredentialsError} naming its tag and message, never its request.
 *
 * @param step - What failed.
 * @returns The mapper.
 */
export const failed = (step: string) => (cause: unknown) =>
  new CredentialsError({
    cause,
    message: `${step} failed${Predicate.hasProperty(cause, "_tag") ? ` (${String(cause._tag)})` : ""}. If the admin token expired, re-mint it with \`bun run alchemy profile edit --profile admin\` and run again. ${STEP_1}`,
  });
