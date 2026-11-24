import { Schema } from "effect";

/**
 * Whether a parsed knip value is an object, whose keys the walk reads.
 */
const isNode = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Whether a parsed knip value is an array, which an `ignore*` key may hold.
 */
const isList = Schema.is(Schema.Array(Schema.Json));

/**
 * Whether a parsed knip value is a string, which counts as one entry wherever it sits.
 */
const isText = Schema.is(Schema.String);

/**
 * The entries beneath an `ignore*` key: a string leaf anywhere counts 1, and so does every array
 * item that is not itself an array or object. Booleans outside an array are settings, not entries.
 */
const leaves = (value: Schema.Json, inList: boolean): number => {
  if (isList(value)) {
    return value.reduce((total: number, item) => total + leaves(item, true), 0);
  }

  if (isNode(value)) {
    return Object.values(value).reduce((total: number, item) => total + leaves(item, false), 0);
  }

  return inList || isText(value) ? 1 : 0;
};

/**
 * The entries beneath every `ignore*` key in a parsed knip configuration, at any depth: a string,
 * an array or an object such as `ignoreIssues`.
 */
export const ignoreEntries = (value: Schema.Json): number => {
  if (isList(value)) {
    return value.reduce((total: number, item) => total + ignoreEntries(item), 0);
  }

  if (!isNode(value)) {
    return 0;
  }

  return Object.entries(value).reduce(
    (total: number, [key, item]) =>
      total + (key.startsWith("ignore") ? leaves(item, false) : ignoreEntries(item)),
    0,
  );
};
