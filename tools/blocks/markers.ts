import { Effect, Schema } from "effect";

/**
 * Raised when a `block:<unit> start` line has no `block:<unit> end` after it. It names the file
 * and the line of the `start`.
 */
export class UnterminatedRegionError extends Schema.TaggedError<
  UnterminatedRegionError,
  { readonly brand: unique symbol }
>()("UnterminatedRegionError", {
  file: Schema.String,
  line: Schema.Finite,
  message: Schema.String,
}) {}

/**
 * Escapes `text` for use inside a regular expression.
 */
const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * The three line patterns of `unit`'s markers. The unit name matches only when the next character
 * is outside `[a-z0-9-]`, so `block:<unit>` never matches `block:<unit>-extra`.
 */
const markerPatterns = (unit: string) => {
  const marker = `block:${escapeRegExp(unit)}(?![a-z0-9-])`;

  return {
    end: new RegExp(`${marker}\\s+end\\b`, "u"),
    start: new RegExp(`${marker}\\s+start\\b`, "u"),
    trailing: new RegExp(`(?://|/\\*)\\s*${marker}(?:\\s*\\*/)?\\s*$`, "u"),
  };
};

/**
 * The lines of `text` that the pull-out of `unit` deletes: each line that ends in a
 * `// block:<unit>` or block-comment `block:<unit>` marker, and each region from a line holding
 * `block:<unit> start` through the next line holding `block:<unit> end`, both lines included.
 *
 * @param unit - The unit name.
 * @param text - The contents of a file.
 * @returns The 1-based numbers of the deleted lines, and the 1-based line of a `start` that has no
 *   `end` (`0` when every region closes).
 */
export const markedLines = (unit: string, text: string) => {
  const { end, start, trailing } = markerPatterns(unit);
  const lines = new Set<number>();
  let opened = 0;

  for (const [index, line] of text.split("\n").entries()) {
    if (opened > 0) {
      lines.add(index + 1);
      opened = end.test(line) ? 0 : opened;
    } else if (start.test(line)) {
      lines.add(index + 1);
      opened = index + 1;
    } else if (trailing.test(line)) {
      lines.add(index + 1);
    }
  }

  return { lines, unterminated: opened };
};

/**
 * The marked-line step of the pull-out on `text`, the contents of `file`: drops the lines
 * {@link markedLines} names. A `start` with no `end` fails naming `file` and the line.
 */
export const removeMarked = (
  unit: string,
  file: string,
  text: string,
): Effect.Effect<string, UnterminatedRegionError> =>
  Effect.suspend(() => {
    const { lines, unterminated } = markedLines(unit, text);

    return unterminated === 0
      ? Effect.succeed(
          text
            .split("\n")
            .filter((_, index) => !lines.has(index + 1))
            .join("\n"),
        )
      : Effect.fail(
          new UnterminatedRegionError({
            file,
            line: unterminated,
            message: `unterminated block:${unit} region ${file}:${unterminated}`,
          }),
        );
  });
