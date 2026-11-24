import { Array as Arr, Option } from "effect";
import { STATE_STACK } from "../state-selection.ts";

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
export const PREVIEW_STAGE = /^staging-[0-9]+$/u;

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
export const hasAppStack = (stdout: string) => lines(stdout).includes(`${STATE_STACK}/`);

/**
 * Classify a failed listing by the store errors alchemy raises (src/State/Provisioning.ts:38-46,
 * :54, :71): `... is out of date (expected vN, observed vM)` is Outdated, `... not found` or `...
 * has an unfinished bootstrap` is Missing. Anything else is Failed with the output's last line, so
 * the CLI's new-version warning ("Run `...` to upgrade.", src/Cli/checkVersion.ts:131) is never
 * read as a store state.
 */
const failedListing: (captured: Captured) => StateListing = (captured) => {
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
export const parseStateList: (stacks: Captured, stages: Option.Option<Captured>) => StateListing = (
  stacks,
  stages,
) => {
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
