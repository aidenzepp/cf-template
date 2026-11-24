import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Config, Console, Effect, Layer, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { STATE_STACK } from "../src/state-selection.ts";
import { APP_STACK_ENTRY } from "../src/app-stack.ts";
import { AccountCountsLive, PreStepError, enforceCap } from "./preview-cap.ts";

/**
 * What one captured command exited with and printed, stdout and stderr apart.
 */
export interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The states the store listing is read in. `Failed` is a nonzero exit that is neither a missing
 * nor an outdated store, carrying the output's last line.
 */
type StateListing =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Outdated" }
  | { readonly _tag: "Failed"; readonly code: number; readonly line: string }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Populated"; readonly stages: ReadonlyArray<string> };

/**
 * A stage a preview deploy owns: `staging-<N>`.
 */
const PREVIEW_STAGE = /^staging-[0-9]+$/u;

/**
 * Any stage name, as the stage part of an `app/<stage>/` line.
 */
const STAGE_TOKEN = /^(?:prod|staging-[0-9]+|test-[a-z0-9-]+)$/u;

/**
 * The trimmed lines of a command's output.
 */
const lines = (text: string) => text.split(/\r?\n/u).map((line) => line.trim());

/**
 * Whether a bare `alchemy state list` lists the app stack. It prints one `${stack}/` line per
 * stack, sorted (alchemy 2.0.0-beta.85 src/State/Tree.ts:184-186, src/Cli/commands/state.ts:129).
 *
 * @param stdout - The bare listing's stdout.
 * @returns `true` when an `app/` line is present.
 */
const hasAppStack = (stdout: string): boolean => lines(stdout).includes(`${STATE_STACK}/`);

/**
 * Classify a failed listing by the store errors alchemy raises (src/State/Provisioning.ts:38-46,
 * :54, :71): `... is out of date (expected vN, observed vM)` is Outdated, `... not found` or `...
 * has an unfinished bootstrap` is Missing. Anything else is Failed with the output's last line, so
 * the CLI's new-version warning ("Run `...` to upgrade.", src/Cli/checkVersion.ts:131) is never
 * read as a store state.
 */
const failedListing = (captured: Captured): StateListing => {
  const output = `${captured.stdout}\n${captured.stderr}`;

  if (/is out of date/u.test(output)) {
    return { _tag: "Outdated" };
  }

  if (/not found|unfinished bootstrap/u.test(output)) {
    return { _tag: "Missing" };
  }

  return {
    _tag: "Failed",
    code: captured.code,
    line: Option.getOrElse(
      Arr.findLast(lines(output), (line) => line !== ""),
      () => "",
    ),
  };
};

/**
 * Classify the two-step listing: the bare `alchemy state list`, then `alchemy state list app` when
 * the app stack exists. The second prints one `app/<stage>/` line per stage (src/State/Tree.ts
 * listState, the `${prefix}${child}/` branch) and fails with `app: path does not exist` when the
 * stack is absent (Tree.ts filesAt and :105, mapped by src/Cli/commands/state.ts:112-113), which
 * reads as Empty. Only stdout is parsed; with `ALCHEMY_LOG_FORMAT=json` log records go to stderr,
 * and the plain renderer's task lines on stdout (`• ...`, `✓ ...`, src/Interaction.ts:426, :437)
 * match neither line shape.
 *
 * @param stacks - The bare listing.
 * @param stages - The app listing, when it ran.
 * @returns The listing state.
 */
export const parseStateList = (stacks: Captured, stages: Option.Option<Captured>): StateListing => {
  if (stacks.code !== 0) {
    return failedListing(stacks);
  }

  if (!hasAppStack(stacks.stdout) || Option.isNone(stages)) {
    return { _tag: "Empty" };
  }

  if (stages.value.code !== 0) {
    return stages.value.stderr.includes(`${STATE_STACK}: path does not exist`)
      ? { _tag: "Empty" }
      : failedListing(stages.value);
  }

  const prefix = `${STATE_STACK}/`;

  const found = lines(stages.value.stdout).flatMap((line) => {
    const stage =
      line.startsWith(prefix) && line.endsWith("/") ? line.slice(prefix.length, -1) : "";

    return STAGE_TOKEN.test(stage) ? [stage] : [];
  });

  return found.length === 0 ? { _tag: "Empty" } : { _tag: "Populated", stages: found };
};

/**
 * Pick the stages the sweep destroys: `staging-<N>` whose pull request is closed or merged. A
 * stage whose state is unknown (a `gh` error) is skipped, and `test-<slug>` is never matched.
 *
 * @param stages - Stage names from the listing.
 * @param prState - The pull request state by stage, or `none` when `gh` failed.
 * @returns The stages to destroy and the leftover set, by name.
 */
export const planSweep = (
  stages: ReadonlyArray<string>,
  prState: (stage: string) => Option.Option<string>,
) => {
  const previews = stages.filter((stage) => PREVIEW_STAGE.test(stage));

  const destroy = previews.filter((stage) =>
    Option.match(prState(stage), {
      onNone: () => false,
      onSome: (state) => state === "CLOSED" || state === "MERGED",
    }),
  );

  return { destroy, leftover: stages.filter((stage) => !destroy.includes(stage)) };
};

/**
 * Run a command, returning its exit code and its stdout and stderr, read apart and concurrently.
 */
const run = Effect.fn("run")(function* run(
  program: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(ChildProcess.make(program, [...args], options));

      const { stderr, stdout } = yield* Effect.all(
        {
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
        },
        { concurrency: "unbounded" },
      );

      const code = yield* handle.exitCode;

      return { code: Number(code), stderr, stdout } satisfies Captured;
    }),
  );
});

/**
 * Run `alchemy` with `ALCHEMY_LOG_FORMAT=json`, so its log records go to stderr as JSON lines
 * (src/Util/LogRecord.ts:215, src/Cli/GlobalLog.ts:117) rather than to stdout through
 * `console.log` (src/Util/ConsoleSink.ts:59-67), leaving stdout to the command's own output.
 */
const alchemy = (args: ReadonlyArray<string>, cwd?: string) =>
  run("alchemy", args, { cwd, env: { ALCHEMY_LOG_FORMAT: "json" }, extendEnv: true });

/**
 * The command an operator runs by hand, from the repository root, to destroy `stage`.
 */
const destroyByHand = (stage: string) =>
  `bun run alchemy destroy ${APP_STACK_ENTRY} --stage ${stage} --yes`;

/**
 * Destroy one stage the way the inlined preview step deploys it: `alchemy destroy <entry> --stage
 * <stage> --yes` from the repository root, since Web's `rootDir` resolves against the working
 * directory and a non-interactive run without `--yes` changes nothing. A nonzero exit fails with
 * the stage, the code and the command that clears it by hand.
 */
const destroyStage = Effect.fn("destroyStage")(function* destroyStage(stage: string) {
  const root = yield* (yield* Path.Path).fromFileUrl(new URL("../..", import.meta.url));

  const { code } = yield* alchemy(["destroy", APP_STACK_ENTRY, "--stage", stage, "--yes"], root);

  return code === 0
    ? undefined
    : yield* new PreStepError({
        message: `Destroying stage ${stage} failed with exit code ${code}. Clear it by hand from the repository root: ${destroyByHand(stage)}`,
      });
});

/**
 * Log why the sweep leaves a stage alone and answer an unknown pull request state.
 */
const skipStage = (stage: string, reason: string) =>
  Effect.logWarning(`The sweep skips ${stage}: ${reason}`).pipe(Effect.as(Option.none<string>()));

/**
 * Read the pull request state of a stage's number, or none on a `gh` error. The error is logged as
 * a warning, so a sweep that skips a stage for want of its state says why.
 */
const readPrState = (stage: string) =>
  run("gh", ["pr", "view", stage.replace("staging-", ""), "--json", "state", "-q", ".state"]).pipe(
    Effect.matchEffect({
      onFailure: (failure) => skipStage(stage, `gh pr view did not run: ${failure.message}`),
      onSuccess: ({ code, stderr, stdout }) =>
        code === 0
          ? Effect.succeedSome(stdout.trim())
          : skipStage(stage, `gh pr view exited ${code}: ${stderr.trim()}`),
    }),
  );

/**
 * Run the pre-step for the current event: on `closed`, list, destroy this PR's stage and sweep;
 * on a deploy, list, sweep and enforce the cap.
 */
export const program = Effect.gen(function* preStep() {
  const stack = yield* Config.String("STACK_NAME");
  const pr = yield* Config.String("PR_NUMBER");
  const closed = (yield* Config.String("PR_ACTION").pipe(Config.withDefault(""))) === "closed";
  const own = `staging-${pr}`;

  const stacks = yield* alchemy(["state", "list"]);

  const listing = parseStateList(
    stacks,
    stacks.code === 0 && hasAppStack(stacks.stdout)
      ? Option.some(yield* alchemy(["state", "list", STATE_STACK]))
      : Option.none(),
  );

  if (listing._tag === "Missing") {
    return yield* new PreStepError({
      message: `The state store ${stack}-state is not bootstrapped, or STACK_NAME was changed.`,
    });
  }

  if (listing._tag === "Outdated") {
    return yield* new PreStepError({
      message: `The state store ${stack}-state is out of date, and a preview cannot upgrade it because this pre-step stops first. Upgrade it from the repository root with the command the bootstrap runs, then re-run the preview: STACK_NAME=${stack} bun run alchemy state bootstrap --config ${APP_STACK_ENTRY} --profile <admin profile>`,
    });
  }

  if (listing._tag === "Failed") {
    return yield* new PreStepError({
      message: `Cannot list the state store ${stack}-state: alchemy state list exited ${listing.code}: ${listing.line}`,
    });
  }

  const stages = listing._tag === "Populated" ? listing.stages : [];

  if (closed) {
    yield* destroyStage(own);
  }

  const states = new Map<string, Option.Option<string>>();

  for (const stage of stages.filter((name) => PREVIEW_STAGE.test(name) && name !== own)) {
    states.set(stage, yield* readPrState(stage));
  }

  const sweep = planSweep(stages, (stage) => states.get(stage) ?? Option.none());

  for (const stage of sweep.destroy) {
    yield* destroyStage(stage);
  }

  const leftover = sweep.leftover.filter((stage) => stage !== own || !closed);
  yield* Console.log(`Leftover stages: ${leftover.join(", ") || "none"}`);

  if (closed) {
    return leftover;
  }

  const count = leftover.filter((stage) => PREVIEW_STAGE.test(stage) && stage !== own).length;
  yield* enforceCap(stack, count, leftover.includes(own));

  return leftover;
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      Effect.tapError((failure) => Console.error(failure.message)),
      Effect.provide(Layer.mergeAll(BunServices.layer, AccountCountsLive)),
    ),
    { disableErrorReporting: true },
  );
}
