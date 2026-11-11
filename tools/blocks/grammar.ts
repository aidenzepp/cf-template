import { Effect, Schema } from "effect";

/**
 * The four attach forms (ST2): an entry of a multi-line `Layer.mergeAll(`, a bare `yield* X;`
 * statement, an `.add(X)` link, and an entry of a multi-line `as const` array.
 */
export type AttachForm = "add" | "array" | "mergeAll" | "yield";

/**
 * The form each attach file uses; `blocks.ts` files and any unlisted file use `Layer.mergeAll(`.
 */
const formsByFile = new Map<string, AttachForm>([
  ["infra/alchemy.run.ts", "yield"],
  ["packages/contract/src/api/api.ts", "add"],
  ["tools/knob/registry.ts", "array"],
]);

/**
 * The form the attach file `file` is read as, by the pull-out and the footprint alike.
 */
export const attachFormOf = (file: string): AttachForm => formsByFile.get(file) ?? "mergeAll";

/**
 * What a line of each form must look like, for the message of a line the grammar cannot read.
 */
const expectedLines: Readonly<Record<AttachForm, string>> = {
  add: "a link `.add(Name)` with a plain identifier",
  array: "one plain identifier per line between `= [` and `]`, such as `Name,`",
  mergeAll: "one plain identifier per line between `Layer.mergeAll(` and `)`, such as `Name,`",
  yield: "a statement `yield* Name;` with a plain identifier",
};

/**
 * The text of the failure for an attach line the grammar cannot read: it names the file and line
 * and the shape `form` expects, so the line can be rewritten without reading the grammar.
 */
export const unreadableMessage = (
  error: { file: string; line: number },
  form: AttachForm,
): string => `unknown attach shape ${error.file}:${error.line}: expected ${expectedLines[form]}`;

/**
 * One attach line, normalized to the form it uses and the identifier it attaches.
 */
export interface AttachLine {
  readonly file: string;
  readonly form: AttachForm;
  readonly line: number;
  readonly name: string;
}

/**
 * Raised when an attach file holds a line of an unknown shape. It is not a dependent: the file is
 * an attach file, so the line must be rewritten into one of the four forms.
 */
export class UnreadableAttachLineError extends Schema.TaggedError<UnreadableAttachLineError>()(
  "UnreadableAttachLineError",
  { file: Schema.String, line: Schema.Number, message: Schema.String },
) {}

/**
 * The result of scanning one attach file: its attach lines, and the 1-based number of the first
 * line of an unknown shape when there is one.
 */
interface Scan {
  readonly attach: ReadonlyArray<AttachLine>;
  readonly bad: number | undefined;
  readonly unit?: string;
}

/**
 * The attached identifier, captured as `name`, on a line holding nothing else.
 */
const identifier = String.raw`(?<name>[A-Za-z_$][\w$]*)`;

/**
 * The entry line shared by the two region forms: one identifier, an optional comma.
 */
const entry = new RegExp(String.raw`^\s*${identifier},?\s*$`, "u");

/**
 * The region forms. A region opens on a line that ends at its bracket, holds one entry per line,
 * and closes on a line that starts with the closing bracket. `collapsed` is an opener with content
 * after the bracket, which would hide entries from a line scan.
 */
const regions = {
  array: { close: /^\s*\]/u, collapsed: /\s=\s*\[\s*\S/u, open: /\s=\s*\[\s*$/u },
  mergeAll: {
    close: /^\s*\)/u,
    collapsed: /Layer\.mergeAll\(\s*\S/u,
    open: /Layer\.mergeAll\(\s*$/u,
  },
} as const;

/**
 * The statement forms. `entry` is the whole attach line; a line `suspect` matches but `entry` does
 * not is an unknown shape.
 */
const statements = {
  add: {
    entry: new RegExp(String.raw`^\s*\.add\(${identifier}\)\s*[;,]?\s*$`, "u"),
    suspect: /\.add\(/u,
  },
  yield: {
    entry: new RegExp(String.raw`^\s*yield\*\s+${identifier}(?:\.[\w$]+)*(?:\([^;]*\))?;\s*$`, "u"),
    suspect: /^\s*yield\*/u,
  },
} as const;

/**
 * A `Layer.mergeAll(A, B)` the formatter collapsed onto one line, with its entries captured as
 * `list`.
 */
const collapsedMergeAll = /Layer\.mergeAll\((?<list>[^()]*)\)/u;

/**
 * Blanks every line and block comment in `text` and keeps the newlines, so line numbers survive.
 * String and template literals are skipped, so a `//` inside one is not a comment.
 */
const stripComments = (text: string): string => {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    const quote = text.charAt(index);

    if (pair === "//") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (pair === "/*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(index, stop).replaceAll(/[^\n]/gu, " ");
      index = stop;
    } else if (quote === '"' || quote === "'" || quote === "`") {
      let stop = index + 1;

      while (stop < text.length && text.charAt(stop) !== quote) {
        stop += text.charAt(stop) === "\\" ? 2 : 1;
      }

      out += text.slice(index, stop + 1);
      index = stop + 1;
    } else {
      out += quote;
      index += 1;
    }
  }

  return out;
};

/**
 * What a collapsed `Layer.mergeAll(...)` line is: core entries, a unit entry that must move to its
 * own line, or a shape that is neither.
 */
type Collapsed =
  | { readonly kind: "core"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "unit"; readonly unit: string }
  | { readonly kind: "unknown" };

/**
 * The marker lines that open and close a unit's region: `// block:<unit> start` and
 * `// block:<unit> end`, each on its own line.
 */
const marker = /^\s*\/\/\s*block:(?<unit>[\w$-]+) (?<edge>start|end)\s*$/u;

/**
 * The unit whose marker region holds each line of `text`, by line index, or `undefined` outside a
 * region.
 */
const regionOwners = (text: string): ReadonlyArray<string | undefined> => {
  const owners: Array<string | undefined> = [];
  let owner: string | undefined;

  for (const line of text.split("\n")) {
    const found = marker.exec(line)?.groups;

    if (found !== undefined) {
      owner = found.edge === "start" ? found.unit : undefined;
    }

    owners.push(found === undefined ? owner : undefined);
  }

  return owners;
};

/**
 * Classifies the collapsed `Layer.mergeAll(...)` on `text` against the unit names `units`. A list
 * made only of the name of `owner`, the unit whose marker region holds the line, is that unit's own
 * line.
 */
const classifyCollapsed = (
  text: string,
  units: ReadonlySet<string>,
  owner: string | undefined,
): Collapsed => {
  const list = collapsedMergeAll.exec(text)?.groups?.list;

  const names = (list ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  if (list === undefined || names.some((name) => entry.exec(name) === null)) {
    return { kind: "unknown" };
  }

  const unit = names.find((name) => units.has(name));

  const own = owner !== undefined && names.every((name) => name === owner);

  return unit === undefined || own ? { kind: "core", names } : { kind: "unit", unit };
};

/**
 * Scans `lines` of a region form. A collapsed `Layer.mergeAll(A, B)` is read as its entries, in
 * order, unless it holds a name of `units`.
 */
const scanRegion = (
  form: "array" | "mergeAll",
  file: string,
  lines: ReadonlyArray<string>,
  units: ReadonlySet<string>,
  owners: ReadonlyArray<string | undefined>,
): Scan => {
  const region = regions[form];
  const attach: Array<AttachLine> = [];
  let inside = false;

  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const name = entry.exec(text)?.groups?.name;

    if (!inside && region.collapsed.test(text)) {
      const collapsed =
        form === "mergeAll" ? classifyCollapsed(text, units, owners[index]) : undefined;

      if (collapsed?.kind === "core") {
        attach.push(...collapsed.names.map((entryName) => ({ file, form, line, name: entryName })));
        continue;
      }

      return collapsed?.kind === "unit"
        ? { attach, bad: line, unit: collapsed.unit }
        : { attach, bad: line };
    }

    if (!inside && region.open.test(text)) {
      inside = true;
    } else if (inside && region.close.test(text)) {
      inside = false;
    } else if (inside && name !== undefined) {
      attach.push({ file, form, line, name });
    } else if (inside && text.trim() !== "") {
      return { attach, bad: line };
    }
  }

  return { attach, bad: undefined };
};

/**
 * Scans `lines` of a statement form. A `yield* X;` whose previous non-blank line ends in `=` is the
 * tail of an assignment, not an attach statement, so it is an unknown shape.
 */
const scanStatements = (
  form: "add" | "yield",
  file: string,
  lines: ReadonlyArray<string>,
): Scan => {
  const statement = statements[form];
  const attach: Array<AttachLine> = [];
  let previous = "";

  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const name = statement.entry.exec(text)?.groups?.name;
    const continued = form === "yield" && previous.endsWith("=");

    if (name !== undefined && !continued) {
      attach.push({ file, form, line, name });
    } else if (statement.suspect.test(text)) {
      return { attach, bad: line };
    }

    previous = text.trim() === "" ? previous : text.trimEnd();
  }

  return { attach, bad: undefined };
};

/**
 * Normalizes the attach lines of `text`, the contents of the attach file `file`, read as `form`:
 * one `{ file, form, line, name }` per attach line, in file order. Lines outside the form are not
 * attach lines and are ignored, and so is every comment. The first line of an unknown shape fails
 * with `unknown attach shape <file>:<line>`; a collapsed `Layer.mergeAll(...)` holding a name of
 * `units` (the slice and block names of blocks.json) fails with `collapsed attach line
 * <file>:<line>: put <unit> on its own line between // block:<unit> start and // block:<unit> end`,
 * unless the line is made only of that unit and sits inside its own marker region.
 */
export const parseAttach = (
  form: AttachForm,
  file: string,
  text: string,
  units: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyArray<AttachLine>, UnreadableAttachLineError> =>
  Effect.suspend(() => {
    const lines = stripComments(text).split("\n");

    const { attach, bad, unit } =
      form === "array" || form === "mergeAll"
        ? scanRegion(form, file, lines, new Set(units), regionOwners(text))
        : scanStatements(form, file, lines);

    return bad === undefined
      ? Effect.succeed(attach)
      : Effect.fail(
          new UnreadableAttachLineError({
            file,
            line: bad,
            message:
              unit === undefined
                ? `unknown attach shape ${file}:${bad}`
                : `collapsed attach line ${file}:${bad}: put ${unit} on its own line between // block:${unit} start and // block:${unit} end`,
          }),
        );
  });
