import { Schema } from "effect";

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
