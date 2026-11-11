import { Effect, Schema } from "effect";

/**
 * The four attach forms (ST2): an entry of a multi-line `Layer.mergeAll(`, a bare `yield* X;`
 * statement, an `.add(X)` link, and an entry of a multi-line `as const` array.
 */
export type AttachForm = "add" | "array" | "mergeAll" | "yield";

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
    entry: new RegExp(String.raw`^\s*yield\*\s+${identifier};\s*$`, "u"),
    suspect: /^\s*yield\*/u,
  },
} as const;

/**
 * Scans `lines` of a region form.
 */
const scanRegion = (
  form: "array" | "mergeAll",
  file: string,
  lines: ReadonlyArray<string>,
): Scan => {
  const region = regions[form];
  const attach: Array<AttachLine> = [];
  let inside = false;

  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const name = entry.exec(text)?.groups?.name;

    if (!inside && region.collapsed.test(text)) {
      return { attach, bad: line };
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
 * attach lines and are ignored. The first line of an unknown shape fails with
 * `unknown attach shape <file>:<line>`.
 */
export const parseAttach = (
  form: AttachForm,
  file: string,
  text: string,
): Effect.Effect<ReadonlyArray<AttachLine>, UnreadableAttachLineError> =>
  Effect.suspend(() => {
    const lines = text.split("\n");

    const { attach, bad } =
      form === "array" || form === "mergeAll"
        ? scanRegion(form, file, lines)
        : scanStatements(form, file, lines);

    return bad === undefined
      ? Effect.succeed(attach)
      : Effect.fail(
          new UnreadableAttachLineError({
            file,
            line: bad,
            message: `unknown attach shape ${file}:${bad}`,
          }),
        );
  });
