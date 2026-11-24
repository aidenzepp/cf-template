import { Effect, Option, Schema } from "effect";

/**
 * The part of `bun.lock` the anchors come from.
 */
const LockJson = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
    ),
  }),
);

/**
 * The `packages` table of `bun.lock`: each key maps to an array whose first element reads
 * `<name>@<version>`.
 */
export type Packages = typeof LockJson.Type.packages;

/**
 * Matches a string literal (kept) or a comment (dropped), so only text outside strings changes.
 */
const comments = /(?<kept>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;

/**
 * Matches a string literal (kept) or a comma that closes an object or array (dropped).
 */
const trailingCommas = /(?<kept>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

/**
 * Turns JSONC into JSON by dropping comments and trailing commas outside strings. `Bun.JSONC` does
 * this on Bun, but the Vitest suite runs on Node, which has no `Bun` global.
 */
const jsoncToJson = (text: string) =>
  text.replaceAll(comments, "$<kept>").replaceAll(trailingCommas, "$<kept>");

/**
 * Parses `bun.lock` (JSONC, with trailing commas) into its `packages` table.
 */
export const readPackages = Effect.fn("mirrors.readPackages")(function* readPackages(text: string) {
  return (yield* Schema.decodeEffect(LockJson)(jsoncToJson(text))).packages;
});

/**
 * The locked version of `anchor`: the text after the last `@` of the package's first element,
 * which reads `<name>@<version>` (the name is read from the element because aliases resolve to
 * another name). Nothing when the anchor is not in the lock.
 */
export const versionOf = (packages: Packages, anchor: string) =>
  Option.fromNullishOr(packages[anchor]?.[0]).pipe(
    Option.map((spec) => spec.slice(spec.lastIndexOf("@") + 1)),
  );
