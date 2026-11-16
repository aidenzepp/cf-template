import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { EmailTokenError } from "./color.ts";
import { generateEmailTokens } from "./generate.ts";

/**
 * Read the theme stylesheet the email tokens are generated from.
 */
const readTheme = Effect.gen(function* readTheme() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(
    path.resolve(import.meta.dirname, "../../packages/ui/src/styles/globals.css"),
  );
}).pipe(Effect.provide(BunServices.layer));

/**
 * The text of one object in the generated module, from its opening line to its closing line.
 *
 * @param module - The generated module text.
 * @param key - The object's key, such as `light` or `radius`.
 * @returns The lines between the braces, or an empty string when the key is missing.
 */
const section = (module: string, key: string): string =>
  module.split(new RegExp(`^ +${key}: \\{$`, "mu"))[1]?.split(/^ +\},?$/mu)[0] ?? "";

/**
 * The entries of one object in the generated module.
 *
 * @param module - The generated module text.
 * @param key - The object's key.
 * @returns Each entry's name and string value, in text order.
 */
const entries = (module: string, key: string): Array<readonly [string, string]> =>
  Array.from(
    section(module, key).matchAll(/^ +"?(?<name>[\w-]+)"?: "(?<value>[^"]*)",$/gmu),
    (match) => [match.groups?.name ?? "", match.groups?.value ?? ""] as const,
  );

/**
 * A theme small enough to read: one alpha token, a base radius and a font.
 */
const small = `:root { --background: oklch(1 0 0); --border: oklch(0.922 0 0); --ring: oklch(0.708 0 0); --radius: 0.5rem; }
.dark { --background: oklch(0.145 0 0); --border: oklch(1 0 0 / 10%); }
@theme inline { --radius-lg: var(--radius); --radius-sm: calc(var(--radius) * 0.5); --font-sans: 'Outfit Variable', sans-serif; }`;

describe("email token generator", () => {
  it.effect("writes every color token of both themes as six-digit hex", () =>
    Effect.gen(function* test() {
      const css = yield* readTheme;
      const module = yield* generateEmailTokens(css);

      const names = new Set(
        Array.from(
          css.matchAll(/^\s+--(?<name>[\w-]+):\s*oklch\(/gmu),
          (match) => match.groups?.name ?? "",
        ),
      );

      assert.isAbove(names.size, 0);

      for (const theme of ["light", "dark"]) {
        const colors = entries(module, theme);

        assert.strictEqual(colors.length, names.size, `${theme} repeats or drops a token`);

        assert.deepStrictEqual(
          new Set(colors.map(([name]) => name)),
          names,
          `${theme} is missing a color token or has an extra one`,
        );

        for (const [name, value] of colors) {
          assert.match(value, /^#[\da-f]{6}$/u, `${theme} ${name}`);
        }
      }

      assert.notInclude(module, "oklch(");
      assert.notInclude(module, "var(");
    }),
  );

  it.effect("resolves the theme to the values the email blocks will paint", () =>
    Effect.gen(function* test() {
      const module = yield* generateEmailTokens(yield* readTheme);
      const light = new Map(entries(module, "light"));
      const dark = new Map(entries(module, "dark"));

      assert.strictEqual(light.get("destructive"), "#e7000b");
      assert.strictEqual(dark.get("destructive"), "#ff6467");
      assert.strictEqual(dark.get("sidebar-primary"), "#1447e6");
      assert.strictEqual(light.get("background"), "#ffffff");
      assert.strictEqual(dark.get("background"), "#0a0a0a");
      assert.strictEqual(light.get("primary-foreground"), "#fafafa");
      assert.strictEqual(dark.get("border"), "#232323");
      assert.strictEqual(dark.get("input"), "#2f2f2f");
      assert.deepStrictEqual(entries(module, "radius"), [
        ["sm", "6px"],
        ["md", "8px"],
        ["lg", "10px"],
        ["xl", "14px"],
        ["2xl", "18px"],
        ["3xl", "22px"],
        ["4xl", "26px"],
      ]);
      assert.deepStrictEqual(entries(module, "font"), [
        ["sans", "'Outfit Variable', sans-serif"],
        ["heading", "'Roboto Slab Variable', serif"],
      ]);
    }),
  );

  it.effect("gives identical text on two runs", () =>
    Effect.gen(function* test() {
      const css = yield* readTheme;
      const first = yield* generateEmailTokens(css);
      const second = yield* generateEmailTokens(css);

      assert.strictEqual(first, second);
    }),
  );

  it.effect("lets the dark theme inherit a token it does not override", () =>
    Effect.gen(function* test() {
      const module = yield* generateEmailTokens(small);

      assert.deepStrictEqual(entries(module, "light"), [
        ["background", "#ffffff"],
        ["border", "#e5e5e5"],
        ["ring", "#a1a1a1"],
      ]);
      assert.deepStrictEqual(entries(module, "dark"), [
        ["background", "#0a0a0a"],
        ["border", "#232323"],
        ["ring", "#a1a1a1"],
      ]);
      assert.deepStrictEqual(entries(module, "radius"), [
        ["sm", "4px"],
        ["lg", "8px"],
      ]);
    }),
  );

  it.effect("fails a token it cannot parse with the typed error, naming it", () =>
    Effect.gen(function* test() {
      const css = small.replace("oklch(0.922 0 0)", "color-mix(in oklch, red, blue)");
      const error = yield* Effect.flip(generateEmailTokens(css));

      assert.instanceOf(error, EmailTokenError);
      assert.include(error.message, ":root --border");
      assert.include(error.message, "color-mix(in oklch, red, blue)");
    }),
  );

  it.effect("fails a dark token that :root does not declare", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(
        generateEmailTokens(small.replace(".dark {", ".dark { --ghost: oklch(0.5 0 0);")),
      );

      assert.instanceOf(error, EmailTokenError);
      assert.include(error.message, ".dark --ghost");
    }),
  );

  it.effect("fails a theme with no background to composite over", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(generateEmailTokens(":root { --border: oklch(1 0 0); }"));

      assert.instanceOf(error, EmailTokenError);
      assert.include(error.message, ":root has no --background");
    }),
  );

  it.effect("fails a radius it cannot resolve and a stylesheet that does not parse", () =>
    Effect.gen(function* test() {
      const radius = yield* Effect.flip(
        generateEmailTokens(
          small.replace("calc(var(--radius) * 0.5)", "calc(var(--radius) - 4px)"),
        ),
      );

      const syntax = yield* Effect.flip(generateEmailTokens(":root { --background: oklch(1 0 0);"));

      assert.instanceOf(radius, EmailTokenError);
      assert.include(radius.message, "@theme --radius-sm");
      assert.instanceOf(syntax, EmailTokenError);
      assert.match(syntax.message, /^the stylesheet does not parse at line 1: /u);
    }),
  );
});
