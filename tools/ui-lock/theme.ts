import { Effect, FileSystem, Schema } from "effect";

/**
 * The stylesheet the pinned CLI writes for this repository's theme, byte for byte: the
 * `src/styles.css` that `shadcn init --preset b5Tj63Ss3U --base base --template start --rtl
 * --pointer` (shadcn 4.23.0, `bun run ui`) generates in a fresh TanStack Start project. It carries
 * the `neutral` variables, the Outfit and Roboto Slab font imports and the pointer-cursor base
 * rule. `add` never rewrites these parts and `init` cannot run in `packages/ui`, so the lock
 * restores them.
 */
const stockStylesheet = `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@fontsource-variable/outfit";
@import "@fontsource-variable/roboto-slab";

@custom-variant dark (&:is(.dark *));

:root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.205 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --accent: oklch(0.97 0 0);
    --accent-foreground: oklch(0.205 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --radius: 0.625rem;
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.145 0 0);
    --sidebar-primary: oklch(0.205 0 0);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.97 0 0);
    --sidebar-accent-foreground: oklch(0.205 0 0);
    --sidebar-border: oklch(0.922 0 0);
    --sidebar-ring: oklch(0.708 0 0);
}

.dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
}

@theme inline {
    --font-sans: 'Outfit Variable', sans-serif;
    --font-heading: 'Roboto Slab Variable', serif;
    --color-sidebar-ring: var(--sidebar-ring);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar: var(--sidebar);
    --color-chart-5: var(--chart-5);
    --color-chart-4: var(--chart-4);
    --color-chart-3: var(--chart-3);
    --color-chart-2: var(--chart-2);
    --color-chart-1: var(--chart-1);
    --color-ring: var(--ring);
    --color-input: var(--input);
    --color-border: var(--border);
    --color-destructive: var(--destructive);
    --color-accent-foreground: var(--accent-foreground);
    --color-accent: var(--accent);
    --color-muted-foreground: var(--muted-foreground);
    --color-muted: var(--muted);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-secondary: var(--secondary);
    --color-primary-foreground: var(--primary-foreground);
    --color-primary: var(--primary);
    --color-popover-foreground: var(--popover-foreground);
    --color-popover: var(--popover);
    --color-card-foreground: var(--card-foreground);
    --color-card: var(--card);
    --color-foreground: var(--foreground);
    --color-background: var(--background);
    --radius-sm: calc(var(--radius) * 0.6);
    --radius-md: calc(var(--radius) * 0.8);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) * 1.4);
    --radius-2xl: calc(var(--radius) * 1.8);
    --radius-3xl: calc(var(--radius) * 2.2);
    --radius-4xl: calc(var(--radius) * 2.6);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
    }
  body {
    @apply bg-background text-foreground;
    }
  button:not(:disabled), [role="button"]:not(:disabled) {
    cursor: pointer;
    }
  html {
    @apply font-sans;
    }
}`;

/**
 * The stylesheet whose text the theme lock pins.
 */
export const themeFile = "packages/ui/src/styles/globals.css";

const selectors = { dark: ".dark", light: ":root" } as const;

/**
 * Raised when the stylesheet differs from stock. The message names every missing, extra and edited
 * theme variable and every other line that differs, and the command that restores stock.
 */
class ThemeMismatchError extends Schema.TaggedError<
  ThemeMismatchError,
  { readonly brand: unique symbol }
>()("ThemeMismatchError", {
  message: Schema.String,
}) {}

/**
 * The start and end offsets of the `selector` block in `css`, the closing brace included, or
 * `undefined` when the block is missing.
 */
const blockRange = (css: string, selector: string): readonly [number, number] | undefined => {
  const start = css.indexOf(`\n${selector} {`);
  const end = css.indexOf("\n}", start);

  return start === -1 || end === -1 ? undefined : [start + 1, end + 2];
};

/**
 * The `--name: value;` declarations of the `selector` block in `css`, as an ordered list of pairs.
 */
const declarations = (css: string, selector: string): ReadonlyArray<readonly [string, string]> => {
  const range = blockRange(css, selector);

  return range === undefined
    ? []
    : [...css.slice(...range).matchAll(/^\s+--(?<name>[\w-]+): (?<value>.+);$/gmu)].map(
        (match) => [match.groups?.name ?? "", match.groups?.value ?? ""] as const,
      );
};

/**
 * The lines of `css` outside its `:root` and `.dark` blocks.
 */
const outsideLines = (css: string): ReadonlyArray<string> => {
  let text = css;

  for (const selector of Object.values(selectors)) {
    const range = blockRange(text, selector);

    text = range === undefined ? text : `${text.slice(0, range[0])}${text.slice(range[1])}`;
  }

  return text.split("\n");
};

/**
 * The lines describing how `css` differs from stock: one per missing, extra or edited theme
 * variable, then one per line outside the theme blocks that stock has and `css` lacks, or the
 * reverse.
 */
export const diffTheme = (css: string): ReadonlyArray<string> => {
  const variables = (["light", "dark"] as const).flatMap((mode) => {
    const selector = selectors[mode];
    const actual = Object.fromEntries(declarations(css, selector));
    const expected = Object.fromEntries(declarations(stockStylesheet, selector));

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

  const actualLines = outsideLines(css);
  const stockLines = outsideLines(stockStylesheet);

  const lines = [
    ...stockLines
      .filter((line) => !actualLines.includes(line))
      .map((line) => `missing line: ${line}`),
    ...actualLines
      .filter((line) => !stockLines.includes(line))
      .map((line) => `extra line: ${line}`),
  ];

  const reordered =
    variables.length === 0 && lines.length === 0 && css !== stockStylesheet
      ? ["reordered or reformatted: the text differs from stock"]
      : [];

  return [...variables, ...lines, ...reordered];
};

/**
 * Rewrites the stylesheet at `file` to the stock text.
 */
export const writeTheme = Effect.fn("ui-lock.writeTheme")(function* writeTheme(file: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(file, stockStylesheet);
});

/**
 * Fails with `ThemeMismatchError` when the stylesheet at `file` differs from stock.
 */
export const checkTheme = Effect.fn("ui-lock.checkTheme")(function* checkTheme(file: string) {
  const fs = yield* FileSystem.FileSystem;
  const differences = diffTheme(yield* fs.readFileString(file));

  return yield* differences.length > 0
    ? new ThemeMismatchError({
        message: `${file} differs from the stock shadcn b5Tj63Ss3U stylesheet:\n${differences.join("\n")}\nRun \`bun run ui:lock\` to restore it.`,
      })
    : Effect.void;
});
