/**
 * The app stack's entry file, relative to the repository root. Every command that plans, deploys or
 * destroys the app stack names this file. Its paths no longer depend on the working directory
 * (Web's `rootDir` resolves from `infra/src/web.ts`), but Alchemy reads `./alchemy.run.ts` by
 * default, so the root-relative entry stays the convention. Workflows cannot import it; their
 * steps spell the same path.
 */
export const APP_STACK_ENTRY = "infra/alchemy.run.ts";
