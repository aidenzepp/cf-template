/**
 * The summary line of a D1 `replace` (#44 item 3). The plan row carries no name field, so the line
 * is printed for every D1 `replace`, explicitly named or not.
 */
export const D1_REPLACE_NOTE =
  "deletes the old database before creating the new one unless `retain`";

/**
 * The summary line of a `prod` plan whose rows are all `create`.
 */
export const ALL_CREATE_NOTE =
  "every row is `create`: prod has no baseline, so the first deploy waits for the owner";

/**
 * The summary line of a plan with no rows. A `prod` stack always plans at least one row, so an
 * empty plan means the plan did not read the stack; it is held like a destructive one. A plan whose
 * rows are all `noop` is the positive "no changes" answer.
 */
export const EMPTY_PLAN_NOTE =
  "the plan has no rows, so it says nothing about prod; held until the owner confirms it";

/**
 * The summary line of a Worker `replace`, `delete` or `orphaned`.
 */
export const WORKER_REMOVED_NOTE = "destroys the storage of every Durable Object this Worker hosts";

/**
 * The summary line of a Worker `update` that removes a binding. A removed Durable Object binding
 * deletes its class; the row does not say which kind of binding it is, so every removal holds.
 */
export const BINDING_REMOVED_NOTE =
  "removes a binding; if it is a Durable Object binding, its class and storage are deleted";
