/**
 * The name the stack program passes to `Alchemy.Stack`, which is the `stack` key of every record
 * Alchemy keeps. It is not the project stack name that names the state store's Worker. A reader of
 * the state, such as `bun run log-key`, asks for records under this name.
 */
export const STATE_STACK = "app";

/**
 * Report whether the stage keeps its state in the project's Cloudflare state store.
 *
 * `prod`, `staging-<N>` and `test-ci` do; `test-<slug>` and `dev` use Alchemy local state. The
 * stack program and the guarded test-stage script both read this one answer, so the script can
 * never approve a stage the stack program would put in a shared store.
 *
 * @param stage - The decoded stage.
 * @returns `true` for a stage that uses the project store.
 */
export const usesProjectState = (stage: string): boolean =>
  stage === "prod" || stage === "test-ci" || stage.startsWith("staging-");
