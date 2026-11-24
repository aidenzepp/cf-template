import { Effect, Schema } from "effect";
import { CssSyntaxError, parse } from "postcss";
import type { AnyNode } from "postcss";

/**
 * The stylesheet does not parse. The message names the file and the line.
 */
export class DesignMdParseError extends Schema.TaggedError<
  DesignMdParseError,
  { readonly brand: unique symbol }
>()("DesignMdParseError", { message: Schema.String }) {}

/**
 * A `--radius-*` step is a `calc()` the generator cannot turn into a plain dimension. The message
 * names the token and the expression.
 */
export class DesignMdResolveError extends Schema.TaggedError<
  DesignMdResolveError,
  { readonly brand: unique symbol }
>()("DesignMdResolveError", { message: Schema.String }) {}

/**
 * The custom properties of the blocks the generator reads: `@theme`, `:root` and `.dark`.
 */
export interface Blocks {
  readonly dark: Map<string, string>;
  readonly root: Map<string, string>;
  readonly theme: Map<string, string>;
}

/**
 * A radius step written as `calc()` of `var(--radius)` and a plain number: `var(--radius) * N`, `N
 *
 * - Var(--radius)`or`var(--radius) / N`.
 */
const RADIUS_CALC =
  /^calc\(\s*(?:var\(--radius\)\s*(?<op>[*/])\s*(?<after>[\d.]+)|(?<before>[\d.]+)\s*\*\s*var\(--radius\))\s*\)$/u;

/**
 * A plain dimension: a number and a unit, such as `0.625rem`.
 */
const DIMENSION = /^(?<amount>[\d.]+)(?<unit>[a-z%]+)$/u;

/**
 * The block a custom property declaration sits in, or nothing for a block the generator ignores.
 *
 * @param parent - The declaration's parent node.
 * @param blocks - The collected blocks.
 * @returns The map the declaration belongs in.
 */
const blockFor = (parent: AnyNode | undefined, blocks: Blocks): Map<string, string> | undefined => {
  if (parent?.type === "atrule" && parent.name === "theme") {
    return blocks.theme;
  }

  if (parent?.type === "rule" && parent.selector === ":root") {
    return blocks.root;
  }

  if (parent?.type === "rule" && parent.selector === ".dark") {
    return blocks.dark;
  }

  return undefined;
};

/**
 * Collect the custom properties of the blocks the generator reads.
 *
 * @param css - The stylesheet text.
 * @param file - The file name used in a parse failure.
 * @returns The collected blocks, or a {@link DesignMdParseError}.
 */
export const readBlocks = (css: string, file: string): Effect.Effect<Blocks, DesignMdParseError> =>
  Effect.try({
    catch: (error) => {
      const line = error instanceof CssSyntaxError ? error.line : undefined;

      const reason =
        error instanceof CssSyntaxError ? error.reason : "the stylesheet does not parse";

      return new DesignMdParseError({ message: `${file}:${line ?? 0}: ${reason}` });
    },
    try: () => {
      const blocks: Blocks = { dark: new Map(), root: new Map(), theme: new Map() };

      parse(css, { from: file }).walkDecls((decl) => {
        if (decl.prop.startsWith("--")) {
          blockFor(decl.parent, blocks)?.set(decl.prop, decl.value);
        }
      });

      return blocks;
    },
  });

/**
 * Resolve one `@theme` value. A `--radius-*` step written as `calc()` of `var(--radius)` and a
 * plain number becomes a dimension in the unit of the `:root` `--radius`, rounded to four decimal
 * places with trailing zeros trimmed. Every other value passes through unchanged.
 *
 * @param prop - The `@theme` property.
 * @param value - Its value.
 * @param radius - The `:root` `--radius` value, when the stylesheet declares one.
 * @returns The resolved value, or a {@link DesignMdResolveError} naming the token and the
 *   expression.
 */
const resolveRadius = (
  prop: string,
  value: string,
  radius: string | undefined,
): Effect.Effect<string, DesignMdResolveError> => {
  if (!prop.startsWith("--radius-") || !value.startsWith("calc(")) {
    return Effect.succeed(value);
  }

  const step = RADIUS_CALC.exec(value)?.groups;
  const base = DIMENSION.exec(radius ?? "")?.groups;

  if (step === undefined || base === undefined) {
    return Effect.fail(
      new DesignMdResolveError({
        message: `${prop}: cannot resolve "${value}" against :root --radius "${radius ?? "(missing)"}"; only calc(var(--radius) * N), calc(N * var(--radius)) and calc(var(--radius) / N) with a plain --radius dimension resolve`,
      }),
    );
  }

  const amount = Number(base.amount);
  const factor = Number(step.after ?? step.before);
  const product = step.op === "/" ? amount / factor : amount * factor;

  return Effect.succeed(`${Number(product.toFixed(4))}${base.unit}`);
};

/**
 * Resolve every `--radius-*` `calc()` step of the `@theme` block into a plain dimension.
 *
 * @param blocks - The collected blocks.
 * @returns The blocks with resolved radius steps, or a {@link DesignMdResolveError}.
 */
export const resolveRadii = (blocks: Blocks): Effect.Effect<Blocks, DesignMdResolveError> =>
  Effect.gen(function* resolveTheme() {
    const theme = new Map<string, string>();

    for (const [prop, value] of blocks.theme) {
      theme.set(prop, yield* resolveRadius(prop, value, blocks.root.get("--radius")));
    }

    return { ...blocks, theme };
  });
