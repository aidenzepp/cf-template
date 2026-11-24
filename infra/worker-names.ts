import { Effect, Schema } from "effect";
import { LONGEST_STAGE } from "./stages.ts";
import type { StageName } from "./stages.ts";

/**
 * The longest Worker name Cloudflare accepts.
 */
const WORKER_NAME_MAX = 54;

/**
 * The Worker ids every stage deploys, the one list the Worker count and the longest Worker name
 * derive from.
 */
export const Workers = ["web", "api", "auth"] as const;

/**
 * The length of the longest entry of {@link Workers}.
 */
const LONGEST_WORKER = Math.max(...Workers.map((worker) => worker.length));

/**
 * The longest stack name that keeps `<stack>-<worker>-<stage>` inside the Worker name limit for
 * the longest Worker and the longest stage.
 */
export const STACK_NAME_MAX = WORKER_NAME_MAX - LONGEST_WORKER - 2 - LONGEST_STAGE;

/**
 * The failure raised when a derived Worker name exceeds the Worker name limit.
 */
export class WorkerNameTooLongError extends Schema.TaggedError<
  WorkerNameTooLongError,
  { readonly brand: unique symbol }
>()("WorkerNameTooLongError", { message: Schema.String, workerName: Schema.String }) {}

/**
 * Construct the name of a Worker for a stage as `<stack>-<worker>-<stage>`, lower case.
 *
 * @param parts - The parts of the name.
 * @param parts.stack - The stack name from `resolveStackName`.
 * @param parts.worker - The Worker id, an entry of {@link Workers}.
 * @param parts.stage - The decoded stage.
 * @returns The Worker name, or a {@link WorkerNameTooLongError} when the name exceeds the Worker
 *   name limit.
 */
export const workerName = (parts: {
  readonly stack: string;
  readonly worker: string;
  readonly stage: StageName;
}): Effect.Effect<string, WorkerNameTooLongError> => {
  const name = `${parts.stack}-${parts.worker}-${parts.stage}`.toLowerCase();

  return name.length > WORKER_NAME_MAX
    ? Effect.fail(
        new WorkerNameTooLongError({
          message: `Worker name ${name} is ${name.length} characters; Cloudflare accepts at most ${WORKER_NAME_MAX}. Shorten the stack name or the stage.`,
          workerName: name,
        }),
      )
    : Effect.succeed(name);
};
