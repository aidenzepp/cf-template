import { Effect } from "effect";
import { CssSyntaxError, parse } from "postcss";
import type { AnyNode } from "postcss";
import { EmailTokenError, oklchToHex } from "./color.ts";

/**
 * The custom properties of the blocks the generator reads: `@theme`, `:root` and `.dark`, in
 * declaration order.
 */
interface Blocks {
  readonly dark: Map<string, string>;
  readonly root: Map<string, string>;
  readonly theme: Map<string, string>;
}

/**
 * The `:root` property that holds the base radius. It is a dimension, so it is not a color token.
 */
const RADIUS = "--radius";

/**
 * The color token whose resolved hex is the surface an alpha color is composited over.
 */
const SURFACE = "--background";

/**
 * The number of pixels in one `rem`, the browser default every email client also assumes.
 */
const PX_PER_REM = 16;

/**
 * A plain dimension in a unit an email client reads: `0.625rem` or `10px`.
 */
const DIMENSION = /^(?<amount>\d+(?:\.\d+)?|\.\d+)(?<unit>px|rem)$/u;

/**
 * A radius step written as `calc(var(--radius) * N)`.
 */
const RADIUS_STEP = /^calc\(\s*var\(--radius\)\s*\*\s*(?<factor>\d+(?:\.\d+)?|\.\d+)\s*\)$/u;

/**
 * A property name that can be written as an object key without quotes.
 */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/**
 * The block a custom property declaration sits in, or nothing for a block the generator ignores.
 *
 * @param parent - The declaration's parent node.
 * @param blocks - The collected blocks.
 * @returns The map the declaration belongs in.
 */
const blockFor = (parent: AnyNode | undefined, blocks: Blocks) => {
  if (parent?.type === "atrule" && parent.name === "theme") {
    return blocks.theme;
  }

  if (parent?.type === "rule" && parent.selector === ":root") {
    return blocks.root;
  }

  return parent?.type === "rule" && parent.selector === ".dark" ? blocks.dark : undefined;
};

/**
 * Collect the custom properties of the blocks the generator reads.
 *
 * @param css - The stylesheet text.
 * @returns The collected blocks, or an {@link EmailTokenError} naming the line that does not parse.
 */
const readBlocks = (css: string) =>
  Effect.try({
    catch: (error) =>
      new EmailTokenError({
        message: `the stylesheet does not parse at line ${error instanceof CssSyntaxError ? error.line : 0}: ${error instanceof CssSyntaxError ? error.reason : "unknown syntax error"}`,
      }),
    try: () => {
      const blocks: Blocks = { dark: new Map(), root: new Map(), theme: new Map() };

      parse(css).walkDecls((decl) => {
        if (decl.prop.startsWith("--")) {
          blockFor(decl.parent, blocks)?.set(decl.prop, decl.value);
        }
      });

      return blocks;
    },
  });

/**
 * Convert one color token, naming the block and property in a failure.
 *
 * @param selector - The block the token sits in, such as `:root`.
 * @param prop - The custom property.
 * @param value - The value as written in the stylesheet.
 * @param surface - The opaque hex an alpha value is composited over.
 * @returns The `#rrggbb` color, or an {@link EmailTokenError} that starts with the block and
 *   property.
 */
const convert = (selector: string, prop: string, value: string, surface?: string) =>
  oklchToHex(value, surface).pipe(
    Effect.mapError(
      (failure) => new EmailTokenError({ message: `${selector} ${prop}: ${failure.message}` }),
    ),
  );

/**
 * Resolve every color token of one theme to opaque hex. Alpha colors are composited over the
 * theme's `--background`, so the surface differs between light and dark.
 *
 * @param selector - The block label used in a failure, such as `.dark`.
 * @param values - The theme's custom properties: `:root`, overlaid with `.dark` for the dark theme.
 * @returns The token name without its `--` and its `#rrggbb` color, in declaration order, or an
 *   {@link EmailTokenError}.
 */
const resolveColors = Effect.fnUntraced(function* resolveColors(
  selector: string,
  values: ReadonlyMap<string, string>,
) {
  const background = values.get(SURFACE);

  if (background === undefined) {
    return yield* new EmailTokenError({
      message: `${selector} has no ${SURFACE}, the surface alpha colors are composited over`,
    });
  }

  const surface = yield* convert(selector, SURFACE, background);
  const colors: Array<readonly [string, string]> = [];

  for (const [prop, value] of values) {
    if (prop !== RADIUS) {
      const hex = prop === SURFACE ? surface : yield* convert(selector, prop, value, surface);

      colors.push([prop.slice(2), hex]);
    }
  }

  return colors;
});

/**
 * Read a dimension as pixels.
 *
 * @param value - A value such as `0.625rem` or `10px`.
 * @returns The pixel count, or nothing when the value is not a `px` or `rem` dimension.
 */
const toPx = (value: string) => {
  const dimension = DIMENSION.exec(value)?.groups;

  return dimension === undefined
    ? undefined
    : Number(dimension.amount) * (dimension.unit === "rem" ? PX_PER_REM : 1);
};

/**
 * Resolve one `@theme` `--radius-*` step to pixels.
 *
 * @param prop - The `@theme` property.
 * @param value - Its value: `var(--radius)`, `calc(var(--radius) * N)` or a `px` or `rem`
 *   dimension.
 * @param base - The `:root` `--radius` in pixels, when it is a dimension.
 * @returns The step in pixels rounded to four decimal places, or an {@link EmailTokenError} naming
 *   the token and the accepted forms.
 */
const resolveRadius = (prop: string, value: string, base: number | undefined) => {
  const factor = RADIUS_STEP.exec(value)?.groups?.factor;
  const px = toPx(value);

  if (px !== undefined) {
    return Effect.succeed(Number(px.toFixed(4)));
  }

  if (base !== undefined && (value === "var(--radius)" || factor !== undefined)) {
    return Effect.succeed(Number((base * Number(factor ?? 1)).toFixed(4)));
  }

  return Effect.fail(
    new EmailTokenError({
      message: `@theme ${prop}: cannot resolve "${value}" to pixels; write var(--radius), calc(var(--radius) * N) or a px or rem dimension, with :root ${RADIUS} a px or rem dimension`,
    }),
  );
};

/**
 * Render an object literal with one entry per line. A key is quoted only when it is not an
 * identifier, so the text is stable under the repository formatter's `as-needed` quoting.
 *
 * @param entries - The key and string value of each entry, in output order.
 * @param indent - The indentation of the line holding the closing brace.
 * @returns The object literal text.
 */
const renderObject = (entries: ReadonlyArray<readonly [string, string]>, indent: string) =>
  entries.length === 0
    ? "{}"
    : `{\n${entries
        .map(
          ([key, value]) =>
            `${indent}  ${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)},`,
        )
        .join("\n")}\n${indent}}`;

/**
 * Generate the TypeScript module of email-safe theme tokens from the theme stylesheet.
 *
 * The module exports `emailTokens`: `color.light` and `color.dark` map each color token (its
 * custom-property name without `--`) to an opaque `#rrggbb` hex, `radius` maps each `--radius-*`
 * step of `@theme` to pixels, and `font` maps each `--font-*` stack of `@theme` as declared. The
 * dark theme is `:root` overlaid with `.dark`, as the cascade resolves it. Colors keep `:root`
 * declaration order, radii ascend by size and then name, and fonts keep declaration order, so the
 * text depends only on the stylesheet: the same input gives the same output, with no timestamp.
 *
 * Every custom property of `:root` and `.dark` except `--radius` must be an `oklch()` color, and
 * `.dark` may only override a property `:root` declares; anything else fails rather than dropping
 * a token from an email.
 *
 * @param css - The text of the theme stylesheet, `packages/ui/src/styles/globals.css`.
 * @returns The module text, or an {@link EmailTokenError} naming the block, property and value that
 *   cannot be converted.
 */
export const generateEmailTokens = Effect.fnUntraced(function* generateEmailTokens(css: string) {
  const blocks = yield* readBlocks(css);

  for (const prop of blocks.dark.keys()) {
    if (prop !== RADIUS && !blocks.root.has(prop)) {
      return yield* new EmailTokenError({
        message: `.dark ${prop}: :root does not declare it, so the light theme has no value; declare it in :root`,
      });
    }
  }

  const light = yield* resolveColors(":root", blocks.root);
  const dark = yield* resolveColors(".dark", new Map([...blocks.root, ...blocks.dark]));
  const base = toPx(blocks.root.get(RADIUS) ?? "");
  const radius: Array<readonly [string, number]> = [];
  const font: Array<readonly [string, string]> = [];

  for (const [prop, value] of blocks.theme) {
    if (prop.startsWith("--radius-")) {
      radius.push([prop.slice("--radius-".length), yield* resolveRadius(prop, value, base)]);
    } else if (prop.startsWith("--font-")) {
      font.push([prop.slice("--font-".length), value.trim()]);
    }
  }

  radius.sort(([nameA, pxA], [nameB, pxB]) => pxA - pxB || (nameA < nameB ? -1 : 1));

  return `/**
 * Email-safe theme tokens: opaque six-digit hex colors for each theme, radii in pixels and font
 * stacks, all resolved from the theme stylesheet because email clients read neither the oklch color
 * function nor CSS variables. Alpha colors are composited over the theme's background.
 *
 * Generated by tools/email-tokens. Do not edit.
 */
export const emailTokens = {
  color: {
    light: ${renderObject(light, "    ")},
    dark: ${renderObject(dark, "    ")},
  },
  radius: ${renderObject(
    radius.map(([name, px]) => [name, `${px}px`]),
    "  ",
  )},
  font: ${renderObject(font, "  ")},
} as const;
`;
});
