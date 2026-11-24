/**
 * The fixed stage of the bootstrap stack. It is this file's own literal: the stack never imports or
 * decodes the app stage Schema of `infra/stages.ts`, so the app stack's `prod` refusal does not
 * apply here.
 */
export const BOOTSTRAP_STAGE = "prod";

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
