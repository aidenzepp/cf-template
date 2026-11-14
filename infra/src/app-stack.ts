/**
 * The app stack's entry file, relative to the repository root. Every command that plans, deploys or
 * destroys the app stack runs from the root and names this file: Web's `rootDir: "apps/web"`
 * (`infra/src/web.ts`) resolves against the working directory, so from `infra/` it reads
 * `infra/apps/web`, which does not exist. Workflows cannot import it; their steps spell the same
 * path and say why.
 */
export const APP_STACK_ENTRY = "infra/alchemy.run.ts";
