import { Effect, Schema } from "effect";

/**
 * Raised when a `block:<unit> start` line has no `block:<unit> end` after it. It names the file
 * and the line of the `start`.
 */
export class UnterminatedRegionError extends Schema.TaggedError<UnterminatedRegionError>()(
  "UnterminatedRegionError",
  { file: Schema.String, line: Schema.Number, message: Schema.String },
) {}

/**
 * Escapes `text` for use inside a regular expression.
 */
const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * The three line patterns of `unit`'s markers. The unit name matches only when the next character
 * is outside `[a-z0-9-]`, so `block:knobs-kv` never matches `block:knobs-kv-extra`.
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
 * The marked-line step of the pull-out on `text`, the contents of `file`: drops each line that ends
 * in a `// block:<unit>` or block-comment `block:<unit>` marker, and each region from a line
 * holding `block:<unit> start` through the next line holding `block:<unit> end`, both lines
 * included. A `start` with no `end` fails naming `file` and the line.
 */
export const removeMarked = (
  unit: string,
  file: string,
  text: string,
): Effect.Effect<string, UnterminatedRegionError> =>
  Effect.suspend(() => {
    const { end, start, trailing } = markerPatterns(unit);
    const kept: Array<string> = [];
    let opened = 0;

    for (const [index, line] of text.split("\n").entries()) {
      if (opened > 0) {
        opened = end.test(line) ? 0 : opened;
      } else if (start.test(line)) {
        opened = index + 1;
      } else if (!trailing.test(line)) {
        kept.push(line);
      }
    }

    return opened === 0
      ? Effect.succeed(kept.join("\n"))
      : Effect.fail(
          new UnterminatedRegionError({
            file,
            line: opened,
            message: `unterminated block:${unit} region ${file}:${opened}`,
          }),
        );
  });
