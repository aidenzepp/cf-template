import { Option, Schema } from "effect";

/**
 * One upstream repository to mirror: the `bun.lock` package whose version picks the tag, and the
 * sparse patterns that bound the checkout. `{version}` in `tag` is replaced by the locked version.
 */
const Mirror = Schema.Struct({
  anchor: Schema.String,
  name: Schema.String,
  repository: Schema.String,
  sparse: Schema.Array(Schema.String),
  tag: Schema.String,
  verify: Schema.String,
});

export type Entry = typeof Mirror.Type;

/**
 * The text of `mirrors.json`.
 */
export const Mirrors = Schema.fromJsonString(Schema.Array(Mirror));

/**
 * What a finished checkout records, so a warm run can tell whether anything changed.
 */
export const Stamp = Schema.Struct({
  exclusions: Schema.Array(Schema.String),
  sparse: Schema.Array(Schema.String),
  tag: Schema.String,
});

type StampValue = typeof Stamp.Type;

/**
 * The negative sparse patterns: files that instruct a harness are reference data here, not
 * instructions.
 */
export const exclusions = ["!CLAUDE.md", "!**/.agents/", "!**/.claude/", "!**/skills/"];

/**
 * What a mirror needs to become current: a fresh clone, or only a new sparse list.
 */
interface Stale {
  readonly action: "clone" | "sparse";
  readonly reason: string;
}

/**
 * The stamp a current checkout of `entry` at the locked `version` carries.
 */
export const expectedStamp = (entry: Entry, version: string): StampValue => ({
  exclusions,
  sparse: entry.sparse,
  tag: entry.tag.replace("{version}", version),
});

/**
 * Compares a checkout's stamp with the expected one: a missing stamp or another tag means a fresh
 * clone, other lists mean a new sparse checkout only.
 */
export const compareStamp = (
  actual: Option.Option<StampValue>,
  expected: StampValue,
): Option.Option<Stale> => {
  if (Option.isNone(actual)) {
    return Option.some<Stale>({ action: "clone", reason: "no stamp" });
  }

  if (actual.value.tag !== expected.tag) {
    return Option.some<Stale>({
      action: "clone",
      reason: `tag ${actual.value.tag}, lock wants ${expected.tag}`,
    });
  }

  return JSON.stringify([actual.value.sparse, actual.value.exclusions]) ===
    JSON.stringify([expected.sparse, expected.exclusions])
    ? Option.none()
    : Option.some<Stale>({ action: "sparse", reason: "sparse patterns or exclusions changed" });
};
