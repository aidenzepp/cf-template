import { Layer } from "effect";
import { BudgetGuardLive } from "@workspace/budget-guard/live";

/**
 * The attach file of the layers `web`'s server entry builds once per isolate from the Worker's
 * `env`, and whose `RequestGuard` it asks about every request. Each entry reads plain bindings
 * only, because `web` has no Worker program in which Alchemy could register a binding. It is a
 * file of its own, apart from `blocks.ts`, so that the server entry does not import the layers
 * that need such a binding.
 */
export const WebRequestLayers = Layer.mergeAll(
  // block:budget-guard start
  BudgetGuardLive,
  // block:budget-guard end
);
