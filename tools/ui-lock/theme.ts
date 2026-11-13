import { Array as Arr, Effect, FileSystem, Order, Schema } from "effect";

/**
 * The theme variables the shadcn `neutral` base colour sets for the `base-nova` style, copied from
 * the `cssVars` of the registry item https://ui.shadcn.com/r/colors/neutral.json that the pinned
 * CLI (`bun run ui`, shadcn 4.23.0) resolves for `baseColor: "neutral"` in
 * `packages/ui/components.json`. `radius` is part of the light set.
 */
export const stockTheme = {
  dark: {
    accent: "oklch(0.269 0 0)",
    "accent-foreground": "oklch(0.985 0 0)",
    background: "oklch(0.145 0 0)",
    border: "oklch(1 0 0 / 10%)",
    card: "oklch(0.205 0 0)",
    "card-foreground": "oklch(0.985 0 0)",
    "chart-1": "oklch(0.87 0 0)",
    "chart-2": "oklch(0.556 0 0)",
    "chart-3": "oklch(0.439 0 0)",
    "chart-4": "oklch(0.371 0 0)",
    "chart-5": "oklch(0.269 0 0)",
    destructive: "oklch(0.704 0.191 22.216)",
    foreground: "oklch(0.985 0 0)",
    input: "oklch(1 0 0 / 15%)",
    muted: "oklch(0.269 0 0)",
    "muted-foreground": "oklch(0.708 0 0)",
    popover: "oklch(0.205 0 0)",
    "popover-foreground": "oklch(0.985 0 0)",
    primary: "oklch(0.922 0 0)",
    "primary-foreground": "oklch(0.205 0 0)",
    ring: "oklch(0.556 0 0)",
    secondary: "oklch(0.269 0 0)",
    "secondary-foreground": "oklch(0.985 0 0)",
    sidebar: "oklch(0.205 0 0)",
    "sidebar-accent": "oklch(0.269 0 0)",
    "sidebar-accent-foreground": "oklch(0.985 0 0)",
    "sidebar-border": "oklch(1 0 0 / 10%)",
    "sidebar-foreground": "oklch(0.985 0 0)",
    "sidebar-primary": "oklch(0.488 0.243 264.376)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-ring": "oklch(0.556 0 0)",
  },
  light: {
    accent: "oklch(0.97 0 0)",
    "accent-foreground": "oklch(0.205 0 0)",
    background: "oklch(1 0 0)",
    border: "oklch(0.922 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.145 0 0)",
    "chart-1": "oklch(0.87 0 0)",
    "chart-2": "oklch(0.556 0 0)",
    "chart-3": "oklch(0.439 0 0)",
    "chart-4": "oklch(0.371 0 0)",
    "chart-5": "oklch(0.269 0 0)",
    destructive: "oklch(0.577 0.245 27.325)",
    foreground: "oklch(0.145 0 0)",
    input: "oklch(0.922 0 0)",
    muted: "oklch(0.97 0 0)",
    "muted-foreground": "oklch(0.556 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    radius: "0.625rem",
    ring: "oklch(0.708 0 0)",
    secondary: "oklch(0.97 0 0)",
    "secondary-foreground": "oklch(0.205 0 0)",
    sidebar: "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.97 0 0)",
    "sidebar-accent-foreground": "oklch(0.205 0 0)",
    "sidebar-border": "oklch(0.922 0 0)",
    "sidebar-foreground": "oklch(0.145 0 0)",
    "sidebar-primary": "oklch(0.205 0 0)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-ring": "oklch(0.708 0 0)",
  },
} as const satisfies Record<"light" | "dark", Record<string, string>>;

/**
 * The stylesheet whose `:root` and `.dark` blocks carry the theme.
 */
export const themeFile = "packages/ui/src/styles/globals.css";

const selectors = { dark: ".dark", light: ":root" } as const;

/**
 * Raised when a theme block in the stylesheet differs from the stock theme. The message names every
 * missing, extra and edited variable and the command that restores stock.
 */
class ThemeMismatchError extends Schema.TaggedError<
  ThemeMismatchError,
  { readonly brand: unique symbol }
>()("ThemeMismatchError", {
  message: Schema.String,
}) {}

/**
 * The `--name: value;` declarations of the `selector` block in `css`, as an ordered list of pairs.
 */
const declarations = (css: string, selector: string): ReadonlyArray<readonly [string, string]> => {
  const start = css.indexOf(`\n${selector} {`);
  const end = css.indexOf("\n}", start);

  return start === -1 || end === -1
    ? []
    : [...css.slice(start, end).matchAll(/^ {2}--(?<name>[\w-]+): (?<value>.+);$/gmu)].map(
        (match) => [match.groups?.name ?? "", match.groups?.value ?? ""] as const,
      );
};

/**
 * The lines describing how the theme blocks of `css` differ from stock: one per missing, extra or
 * edited variable.
 */
export const diffTheme = (css: string): ReadonlyArray<string> =>
  (["light", "dark"] as const).flatMap((mode) => {
    const selector = selectors[mode];
    const actual = Object.fromEntries(declarations(css, selector));
    const expected: Record<string, string> = stockTheme[mode];

    return [
      ...Object.keys(expected)
        .filter((name) => !(name in actual))
        .map((name) => `${selector} missing: --${name}`),
      ...Object.keys(actual)
        .filter((name) => !(name in expected))
        .map((name) => `${selector} extra: --${name}`),
      ...Object.keys(actual)
        .filter((name) => name in expected && expected[name] !== actual[name])
        .map((name) => `${selector} edited: --${name}: ${actual[name]} (stock ${expected[name]})`),
    ];
  });

/**
 * The text of the `selector` block holding the stock variables of `mode`, in the order the CLI
 * writes them: `radius` first, then alphabetical.
 */
const renderBlock = (mode: "light" | "dark"): string => {
  const theme: Record<string, string> = stockTheme[mode];

  const sorted = Arr.sort(Object.keys(theme), Order.String);

  const names = [
    ...sorted.filter((name) => name === "radius"),
    ...sorted.filter((name) => name !== "radius"),
  ];

  return `${selectors[mode]} {\n${names.map((name) => `  --${name}: ${theme[name]};`).join("\n")}\n}`;
};

/**
 * Rewrites the `:root` and `.dark` blocks of `css` to the stock variables. The caller guarantees
 * both blocks exist.
 */
export const applyStockTheme = (css: string): string => {
  let text = css;

  for (const mode of ["light", "dark"] as const) {
    const start = text.indexOf(`\n${selectors[mode]} {`) + 1;
    const end = text.indexOf("\n}", start) + 2;

    text = `${text.slice(0, start)}${renderBlock(mode)}${text.slice(end)}`;
  }

  return text;
};

/**
 * Rewrites the theme blocks of the stylesheet at `file` to the stock variables.
 */
export const writeTheme = Effect.fn("ui-lock.writeTheme")(function* writeTheme(file: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(file, applyStockTheme(yield* fs.readFileString(file)));
});

/**
 * Fails with `ThemeMismatchError` when the theme blocks of the stylesheet at `file` differ from
 * stock.
 */
export const checkTheme = Effect.fn("ui-lock.checkTheme")(function* checkTheme(file: string) {
  const fs = yield* FileSystem.FileSystem;
  const differences = diffTheme(yield* fs.readFileString(file));

  return yield* differences.length > 0
    ? new ThemeMismatchError({
        message: `${file} differs from the stock shadcn neutral theme:\n${differences.join("\n")}\nRun \`bun run ui:lock\` to restore it.`,
      })
    : Effect.void;
});
