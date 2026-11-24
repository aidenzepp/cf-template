import type { ReadProbe } from "./model.ts";

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
