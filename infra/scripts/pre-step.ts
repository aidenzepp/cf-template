import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as cfD1 from "@distilled.cloud/cloudflare/d1";
import * as cfWorkers from "@distilled.cloud/cloudflare/workers";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import {
  Array as Arr,
  Config,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CloudflarePlanKnob } from "@workspace/config/plan";
import { STATE_STACK } from "../src/state-selection.ts";
import { Workers } from "../stages.ts";

/**
 * The failure of the preview pre-step, with the message the workflow log shows.
 */
export class PreStepError extends Schema.TaggedError<
  PreStepError,
  { readonly brand: unique symbol }
>()("PreStepError", {
  message: Schema.String,
}) {}

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
export type StateListing =
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
 * The Workers and D1 databases a plan includes: Workers 500 and D1 100,000 on `paid`.
 */
const INCLUDED = {
  free: { d1: 10, workers: 100 },
  paid: { d1: 100_000, workers: 500 },
} as const;

/**
 * The D1 databases each stage creates.
 */
const PER_STAGE_D1 = 2;

/**
 * Inputs of the preview cap.
 */
export interface CapInput {
  readonly plan: "free" | "paid";
  readonly limit: number;
  readonly liveOtherWorkers: number;
  readonly liveOtherD1: number;
  readonly capWorkers?: number | undefined;
  readonly capD1?: number | undefined;
}

/**
 * Compute `min(PREVIEW_STAGE_LIMIT, capacity)` over Workers and D1, reserves 0, where a `CAP_<r>`
 * override replaces that resource's capacity.
 *
 * @param input - The plan, the limit and the live counts of the account's other resources.
 * @returns The most `staging-<N>` stages the account holds.
 */
export const previewCap = (input: CapInput): number => {
  const included = INCLUDED[input.plan];

  const workers =
    input.capWorkers ?? Math.floor((included.workers - input.liveOtherWorkers) / Workers.length);

  const d1 = input.capD1 ?? Math.floor((included.d1 - input.liveOtherD1) / PER_STAGE_D1);

  return Math.max(0, Math.min(input.limit, workers, d1));
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
 * Wrap a failed Cloudflare read as a {@link PreStepError}.
 */
const countsFailed = (cause: unknown) =>
  new PreStepError({
    message: `Cannot read the account's Workers and D1 counts: ${cause instanceof Error ? cause.message : "Cloudflare request failed"}. The credentials need Workers Scripts and D1 read.`,
  });

/**
 * The live counts of the account's Workers and D1 databases that do not belong to this project.
 * Tests provide a fake; {@link AccountCountsLive} reads the account.
 */
export class AccountCounts extends Context.Service<
  AccountCounts,
  {
    /**
     * Count the account's Workers and D1 databases whose names do not start with `<stack>-`.
     */
    readonly read: (
      stack: string,
    ) => Effect.Effect<{ readonly workers: number; readonly d1: number }, PreStepError>;
  }
>()("infra/AccountCounts") {}

/**
 * Read the counts through the Cloudflare route the rate-limit guard uses: `CloudflareApiLive`
 * resolves the credentials and the account, and this reads no profile, token or id source.
 */
const AccountCountsLive = Layer.effect(
  AccountCounts,
  Effect.gen(function* buildAccountCounts() {
    const context = yield* Layer.build(
      Layer.provide(
        CloudflareApiLive(),
        Layer.mergeAll(BunServices.layer, AuthProvidersLive, FetchHttpClient.layer),
      ),
    );

    return AccountCounts.of({
      read: (stack) =>
        Cloudflare.CloudflareEnvironment.current.pipe(
          Effect.flatMap(({ accountId }) =>
            Effect.all({
              d1: cfD1.listDatabases.items({ accountId }).pipe(
                Stream.filter((db) => !(db.name ?? "").startsWith(`${stack}-`)),
                Stream.runCount,
              ),
              workers: cfWorkers.listScripts.items({ accountId }).pipe(
                Stream.filter((script) => !(script.id ?? "").startsWith(`${stack}-`)),
                Stream.runCount,
              ),
            }),
          ),
          Effect.provideContext(context),
          Effect.mapError(countsFailed),
        ),
    });
  }),
);

/**
 * Enforce the preview cap: fail when `count` staging stages already exist at or past
 * `min(PREVIEW_STAGE_LIMIT, capacity)` and this PR's stage is not one of them.
 *
 * `PREVIEW_STAGE_LIMIT`, `CLOUDFLARE_PLAN`, `CAP_WORKERS` and `CAP_D1` are read through `Config`.
 *
 * @param stack - The project stack name.
 * @param count - The `staging-<N>` stages other than this PR's.
 * @param hasOwn - Whether this PR's stage already exists.
 * @returns Success, or {@link PreStepError} with the cap message.
 */
export const enforceCap = Effect.fn("enforceCap")(function* enforceCap(
  stack: string,
  count: number,
  hasOwn: boolean,
) {
  const limit = yield* Config.Int("PREVIEW_STAGE_LIMIT").pipe(Config.withDefault(10));
  const plan = yield* CloudflarePlanKnob.config;
  const capWorkers = yield* Config.Int("CAP_WORKERS").pipe(Config.option);
  const capD1 = yield* Config.Int("CAP_D1").pipe(Config.option);
  const live = yield* (yield* AccountCounts).read(stack);

  const cap = previewCap({
    capD1: Option.getOrUndefined(capD1),
    capWorkers: Option.getOrUndefined(capWorkers),
    limit,
    liveOtherD1: live.d1,
    liveOtherWorkers: live.workers,
    plan,
  });

  return count >= cap && !hasOwn
    ? yield* new PreStepError({
        message: `Preview limit reached: ${count} staging stages exist and the cap is ${cap}. Close a pull request or raise PREVIEW_STAGE_LIMIT.`,
      })
    : cap;
});

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
 * The entry file the inlined deploy steps pass to `alchemy`, relative to the repository root.
 */
const ENTRY = "infra/alchemy.run.ts";

/**
 * The command an operator runs by hand, from the repository root, to destroy `stage`.
 */
const destroyByHand = (stage: string) => `bun run alchemy destroy ${ENTRY} --stage ${stage} --yes`;

/**
 * Destroy one stage the way the inlined preview step deploys it: `alchemy destroy <entry> --stage
 * <stage> --yes` from the repository root, since Web's `rootDir` resolves against the working
 * directory and a non-interactive run without `--yes` changes nothing. A nonzero exit fails with
 * the stage, the code and the command that clears it by hand.
 */
const destroyStage = Effect.fn("destroyStage")(function* destroyStage(stage: string) {
  const root = yield* (yield* Path.Path).fromFileUrl(new URL("../..", import.meta.url));

  const { code } = yield* alchemy(["destroy", ENTRY, "--stage", stage, "--yes"], root);

  return code === 0
    ? undefined
    : yield* new PreStepError({
        message: `Destroying stage ${stage} failed with exit code ${code}. Clear it by hand from the repository root: ${destroyByHand(stage)}`,
      });
});

/**
 * Read the pull request state of a stage's number, or none on a `gh` error.
 */
const readPrState = (stage: string) =>
  run("gh", ["pr", "view", stage.replace("staging-", ""), "--json", "state", "-q", ".state"]).pipe(
    Effect.map(({ code, stdout }) => (code === 0 ? Option.some(stdout.trim()) : Option.none())),
    Effect.orElseSucceed(() => Option.none<string>()),
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
      message: `The state store ${stack}-state is out of date, and a preview cannot upgrade it because this pre-step stops first. Upgrade it from the repository root with the command the bootstrap runs, then re-run the preview: STACK_NAME=${stack} bun run alchemy state bootstrap --config ${ENTRY} --profile <admin profile>`,
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
