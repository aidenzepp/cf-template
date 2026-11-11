import { Layer } from "effect";
import { BudgetGuardLive } from "@workspace/budget-guard/live";

/**
 * No layer: the entry that keeps {@link WebRequestLayers} a valid call when no block adds one. It
 * is a named constant because the attach grammar reads one bare identifier per line.
 */
const NoRequestLayers = Layer.empty;

/**
 * The attach file of the layers `web`'s server entry builds once per isolate from the Worker's
 * `env`, and whose `RequestGuard` it asks about every request. Each entry reads plain bindings
 * only, because `web` has no Worker program in which Alchemy could register a binding. It is a
 * file of its own, apart from `blocks.ts`, so that the server entry does not import the layers
 * that need such a binding.
 *
 * `NoRequestLayers` is core, outside every region: `mergeAll` needs one layer, so with each
 * block's entry pulled out the list is still a valid layer and `web` serves with no request guard.
 */
export const WebRequestLayers = Layer.mergeAll(
  NoRequestLayers,
  // block:budget-guard start
  BudgetGuardLive,
  // block:budget-guard end
);
