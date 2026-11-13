import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import { CssSyntaxError, parse } from "postcss";
import type { AnyNode } from "postcss";

/**
 * The stylesheet does not parse. The message names the file and the line.
 */
export class DesignMdParseError extends Schema.TaggedError<DesignMdParseError>()(
  "DesignMdParseError",
  { message: Schema.String },
) {}

/**
 * The guidance file repeats a heading the generator writes. The message names the heading.
 */
export class DesignMdGuidanceError extends Schema.TaggedError<DesignMdGuidanceError>()(
  "DesignMdGuidanceError",
  { message: Schema.String },
) {}

/**
 * The custom properties of the blocks the generator reads: `@theme`, `:root` and `.dark`.
 */
interface Blocks {
  readonly dark: Map<string, string>;
  readonly root: Map<string, string>;
  readonly theme: Map<string, string>;
}

/**
 * A custom property no token group takes, kept for the prose: its block label, name and value.
 */
type Leftover = readonly [label: string, prop: string, value: string];

/**
 * A token group: names to YAML scalars, already rendered.
 */
type Group = Map<string, string>;

/**
 * A `@theme` alias such as `--color-primary: var(--primary)`.
 */
const ALIAS = /^var\((?<name>--[\w-]+)\)$/u;

/**
 * A line height written as `calc()` of two plain numbers.
 */
const RATIO = /^calc\(\s*(?<top>[\d.]+)\s*\/\s*(?<bottom>[\d.]+)\s*\)$/u;

/**
 * Every `var()` reference in a value.
 */
const VAR_REF = /var\((?<name>--[\w-]+)\)/gu;

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
const readBlocks = (css: string, file: string): Effect.Effect<Blocks, DesignMdParseError> =>
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
 * The tokens the generator takes from the blocks, and the properties it took them from.
 */
interface Tokens {
  readonly colors: Group;
  readonly rounded: Group;
  readonly spacing: Group;
  readonly typography: Map<string, Group>;
  readonly used: Set<string>;
}

/**
 * The tokens and the `:root` property each aliased color came from.
 */
interface Taken {
  readonly aliases: Map<string, string>;
  readonly tokens: Tokens;
}

/**
 * Record one color: its `:root` value, and its `.dark` value under the `-dark` name.
 *
 * @param tokens - The tokens being collected.
 * @param blocks - The collected blocks.
 * @param name - The token name.
 * @param source - The custom property the theme alias points at.
 * @param prop - The `@theme` alias property.
 */
const takeAliasedColor = (
  tokens: Tokens,
  blocks: Blocks,
  name: string,
  source: string,
  prop: string,
): void => {
  tokens.colors.set(name, JSON.stringify(blocks.root.get(source)));
  tokens.used.add(`@theme ${prop}`);
  tokens.used.add(`:root ${source}`);

  const dark = blocks.dark.get(source);

  if (dark !== undefined) {
    tokens.colors.set(`${name}-dark`, JSON.stringify(dark));
    tokens.used.add(`.dark ${source}`);
  }
};

/**
 * Record one `--text-*` property into the typography step it names.
 *
 * @param tokens - The tokens being collected.
 * @param prop - The `--text-*` property.
 * @param value - Its value.
 */
const takeText = (tokens: Tokens, prop: string, value: string): void => {
  const [step = "", detail] = prop.slice("--text-".length).split("--");
  const entry = tokens.typography.get(step) ?? new Map<string, string>();
  const ratio = RATIO.exec(value)?.groups;

  if (detail === "line-height" && ratio !== undefined) {
    entry.set("lineHeight", String(Number((Number(ratio.top) / Number(ratio.bottom)).toFixed(4))));
  } else if (detail === "line-height") {
    entry.set("lineHeight", JSON.stringify(value));
  } else if (detail === "letter-spacing") {
    entry.set("letterSpacing", JSON.stringify(value));
  } else {
    entry.set("fontSize", JSON.stringify(value));
  }

  tokens.typography.set(step, entry);
  tokens.used.add(`@theme ${prop}`);
};

/**
 * Take every token group out of the `@theme` block.
 *
 * @param blocks - The collected blocks.
 * @returns The tokens and the `:root` property each aliased color came from.
 */
const takeTokens = (blocks: Blocks): Taken => {
  const tokens: Tokens = {
    colors: new Map(),
    rounded: new Map(),
    spacing: new Map(),
    typography: new Map(),
    used: new Set(),
  };

  const aliases = new Map<string, string>();

  const literal = (group: Group, prefix: string, prop: string, value: string): void => {
    group.set(prop.slice(prefix.length), JSON.stringify(value));
    tokens.used.add(`@theme ${prop}`);
  };

  for (const [prop, value] of blocks.theme) {
    const source = ALIAS.exec(value)?.groups?.name;

    if (prop.startsWith("--color-") && source !== undefined && blocks.root.has(source)) {
      const name = prop.slice("--color-".length);

      aliases.set(source, name);
      takeAliasedColor(tokens, blocks, name, source, prop);
    } else if (prop.startsWith("--color-") && source === undefined) {
      literal(tokens.colors, "--color-", prop, value);
    } else if (prop.startsWith("--radius-") && source === undefined) {
      literal(tokens.rounded, "--radius-", prop, value);
    } else if (prop.startsWith("--spacing-") && source === undefined) {
      literal(tokens.spacing, "--spacing-", prop, value);
    } else if (prop.startsWith("--text-")) {
      takeText(tokens, prop, value);
    }
  }

  return { aliases, tokens };
};

/**
 * Point every `var()` at a mapped color at the spec reference `{colors.name}`; a `-dark` token
 * points at the `-dark` token.
 *
 * @param colors - The color group, already quoted.
 * @param aliases - Each aliased `:root` property and the token it became.
 */
const resolveReferences = (colors: Group, aliases: ReadonlyMap<string, string>): void => {
  for (const [name, quoted] of colors) {
    const suffix = name.endsWith("-dark") ? "-dark" : "";

    colors.set(
      name,
      quoted.replaceAll(VAR_REF, (whole, source: string) => {
        const token = aliases.get(source);

        return token === undefined ? whole : `{colors.${token}${suffix}}`;
      }),
    );
  }
};

/**
 * Render a group of YAML scalars as an indented YAML map.
 *
 * @param name - The group's key.
 * @param group - The group.
 * @param depth - The indentation, in spaces, of the group's key.
 * @returns The YAML lines, empty for an empty group.
 */
const yamlGroup = (name: string, group: ReadonlyMap<string, string>, depth = 0): string => {
  if (group.size === 0) {
    return "";
  }

  const pad = " ".repeat(depth);

  return `${pad}${name}:\n${[...group].map(([key, value]) => `${pad}  ${key}: ${value}`).join("\n")}\n`;
};

/**
 * Whether a custom property belongs to a prose section.
 */
const matches = (pattern: RegExp) => (prop: string) => pattern.test(prop);

/**
 * Render the prose lines for the leftovers a section keeps.
 *
 * @param leftovers - The properties no token group took.
 * @param keep - Whether a property belongs in this section.
 * @returns One bullet per property.
 */
const prose = (leftovers: ReadonlyArray<Leftover>, keep: (prop: string) => boolean): string =>
  leftovers
    .flatMap(([label, prop, value]) =>
      keep(prop) ? [`- \`${prop}\` (${label}): \`${value}\``] : [],
    )
    .join("\n");

/**
 * Render one `##` section.
 *
 * @param title - The heading.
 * @param intro - The opening sentence.
 * @param extra - Further lines, or an empty string.
 * @returns The section text.
 */
const section = (title: string, intro: string, extra: string): string =>
  `## ${title}\n\n${intro}\n${extra === "" ? "" : `\n${extra}\n`}`;

/**
 * Whether a custom property has a section of its own, so it is not named in the Overview.
 */
const hasSection = matches(/^--(?:shadow|radius|font|text|spacing)/u);

/**
 * Render the `DESIGN.md` text for the collected blocks.
 *
 * @param blocks - The parsed custom properties.
 * @returns The `DESIGN.md` text.
 */
const render = (blocks: Blocks): string => {
  const { aliases, tokens } = takeTokens(blocks);

  resolveReferences(tokens.colors, aliases);

  const typography = new Map(
    [...tokens.typography].map(([step, props]) => [step, yamlGroup(step, props, 2)] as const),
  );

  const typographyYaml =
    typography.size === 0 ? "" : `typography:\n${[...typography.values()].join("")}`;

  const leftovers = [
    ...Array.from(blocks.theme, ([prop, value]): Leftover => ["@theme", prop, value]),
    ...Array.from(blocks.root, ([prop, value]): Leftover => [":root", prop, value]),
    ...Array.from(blocks.dark, ([prop, value]): Leftover => [".dark", prop, value]),
  ].filter(([label, prop]) => !tokens.used.has(`${label} ${prop}`));

  const front = [
    "---\nversion: alpha\nname: Workspace UI\n",
    "description: Theme tokens generated from packages/ui/src/styles/globals.css.\n",
    "omitted:\n  - components\n",
    yamlGroup("colors", tokens.colors),
    typographyYaml,
    yamlGroup("rounded", tokens.rounded),
    yamlGroup("spacing", tokens.spacing),
    "---\n",
  ].join("");

  const body = [
    section(
      "Overview",
      "Generated by `bun run design:md` from `packages/ui/src/styles/globals.css`. Do not edit by hand. A color's dark value is a separate token with a `-dark` suffix on the light name; the format has no dark mode, so the suffix is this repository's own convention.",
      prose(leftovers, (prop) => !hasSection(prop)),
    ),
    section(
      "Colors",
      "Each token is the `:root` value of a theme color; its `-dark` token is the `.dark` value.",
      "",
    ),
    section(
      "Typography",
      "Each step names the font size, line height and letter spacing the theme declares.",
      prose(leftovers, matches(/^--(?:font|text)/u)),
    ),
    section(
      "Layout",
      "Spacing steps the theme declares.",
      prose(leftovers, matches(/^--spacing/u)),
    ),
    section(
      "Elevation & Depth",
      "Shadows the theme declares.",
      prose(leftovers, matches(/^--shadow/u)),
    ),
    section(
      "Shapes",
      "Corner radius steps the theme declares.",
      prose(leftovers, matches(/^--radius/u)),
    ),
  ].join("\n");

  return `${front}\n${body}`;
};

/**
 * The `##` headings of a text.
 *
 * @param text - The text to scan.
 * @returns Each heading line.
 */
const headings = (text: string): ReadonlyArray<string> => text.match(/^## .+$/gmu) ?? [];

/**
 * Fail when the guidance repeats a `##` heading of the generated text.
 *
 * @param generated - The generated text.
 * @param guidance - The hand-written guidance text.
 * @returns The guidance, or a {@link DesignMdGuidanceError} naming the repeated heading.
 */
const appendGuidance = (
  generated: string,
  guidance: string,
): Effect.Effect<string, DesignMdGuidanceError> => {
  const written = new Set(headings(generated));
  const repeated = headings(guidance).find((heading) => written.has(heading));

  return repeated === undefined
    ? Effect.succeed(guidance === "" ? generated : `${generated}\n${guidance}`)
    : Effect.fail(
        new DesignMdGuidanceError({
          message: `guidance repeats the generated heading "${repeated}"; the generator writes it already`,
        }),
      );
};

/**
 * Generate the `DESIGN.md` text for one stylesheet: the generated tokens, then the guidance.
 *
 * @param file - The stylesheet's name, used in a parse failure.
 * @param css - The stylesheet text.
 * @param guidance - The hand-written guidance appended after the generated sections.
 * @returns The `DESIGN.md` text, or a {@link DesignMdParseError} or {@link DesignMdGuidanceError}.
 */
export const generate = (
  file: string,
  css: string,
  guidance = "",
): Effect.Effect<string, DesignMdParseError | DesignMdGuidanceError> =>
  Effect.flatMap(Effect.map(readBlocks(css, file), render), (generated) =>
    appendGuidance(generated, guidance),
  );

/**
 * Read a stylesheet and optionally a guidance file, and generate the `DESIGN.md` text.
 *
 * @param path - The stylesheet path.
 * @param guidancePath - The guidance file path, if any.
 * @returns The `DESIGN.md` text, or a failure naming the file.
 */
export const generateFrom = Effect.fn("designMd.generateFrom")(function* generateFrom(
  path: string,
  guidancePath?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const guidance = guidancePath === undefined ? "" : yield* fs.readFileString(guidancePath);

  return yield* generate(path, yield* fs.readFileString(path), guidance);
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const fs = yield* FileSystem.FileSystem;
      const root = (yield* Path.Path).resolve(import.meta.dirname, "../..");

      yield* fs.writeFileString(
        `${root}/DESIGN.md`,
        yield* generateFrom(
          `${root}/packages/ui/src/styles/globals.css`,
          `${root}/tools/design-md/guidance.md`,
        ),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
