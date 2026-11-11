/**
 * The `run[A-Z]*` exports of `effect/Effect`. `ManagedRuntime` methods share these names, so one
 * list bans both. `tools/lint/run-family.test.ts` pins it to the installed Effect.
 */
export const runNames = [
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
] as const;

/**
 * The message every run-family diagnostic carries.
 */
export const runMessage = "Effect.run* only at a runtime boundary";

/**
 * The `no-restricted-properties` entries of the root rule: one per run-family name, so a member
 * call on `Effect` or on a `ManagedRuntime` is banned. P5 appends its data-access entries here.
 */
export const runMembers = runNames.map((property) => ({ message: runMessage, property }));
