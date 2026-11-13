import { BunServices } from "@effect/platform-bun";

import { assert, describe, it } from "@effect/vitest";

import { Effect, FileSystem, Path, Schema } from "effect";

import config from "../../vite.config.ts";

/**
 * A rule table: rule name to its JSON setting.
 */
const Rules = Schema.Record(Schema.String, Schema.Json);

/**
 * The part of a fixture's `.oxlintrc.json` this test compares with the applied configuration.
 */
const FixtureConfig = Schema.fromJsonString(
  Schema.Struct({
    overrides: Schema.optional(
      Schema.Array(
        Schema.Struct({
          files: Schema.Array(Schema.String),
          rules: Rules,
        }),
      ),
    ),
    rules: Rules,
    settings: Schema.Struct({ shadcn: Schema.Unknown }),
  }),
);

/**
 * The glob the shadcn preset uses to switch the registry-owned components off.
 */
const uiGlob = "**/components/ui/**";

/**
 * Normalizes a rule setting to a comparable JSON string: `"error"` and `["error"]` are equal, an
 * absent setting is `"absent"`.
 */
const normalize = (setting: Schema.Json | undefined) => {
  if (setting === undefined) {
    return "absent";
  }

  if (Array.isArray(setting) && setting.length === 1) {
    return JSON.stringify(setting[0]);
  }

  return JSON.stringify(setting);
};

/**
 * The rules the applied configuration (`lint.extends` presets, then `lint.rules`) enables for a
 * file outside `components/ui`, and for one inside it (matching overrides applied on top).
 */
/**
 * Merges rule tables left to right, the later setting replacing the earlier.
 */
const merge = (tables: ReadonlyArray<object | undefined>) =>
  Object.fromEntries(tables.flatMap((table) => Object.entries(table ?? {})));

const applied = Effect.fnUntraced(function* applied() {
  const lint = config.lint ?? {};
  const layers = [...(lint.extends ?? [])];

  const overrides = [
    ...layers.flatMap((layer) => layer.overrides ?? []),
    ...(lint.overrides ?? []),
  ].filter((override) => (override.files ?? []).includes(uiGlob));

  const base = merge([...layers.map((layer) => layer.rules), lint.rules]);
  const exempt = merge([base, ...overrides.map((override) => override.rules)]);

  return {
    base: yield* Schema.decodeUnknownEffect(Rules)(base),
    exempt: yield* Schema.decodeUnknownEffect(Rules)(exempt),
  };
});

describe("shadcn fixtures follow the applied preset", () => {
  it.effect(
    "each shadcn fixture rule is enabled in the applied config with the fixture's options",
    () =>
      Effect.gen(function* check() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* path.fromFileUrl(new URL("fixtures", import.meta.url));
        const entries = yield* fs.readDirectory(dir);

        const names = entries.filter((name) => name.startsWith("shadcn-"));

        assert.isAbove(names.length, 0);

        const { base, exempt } = yield* applied();

        for (const name of names) {
          const text = yield* fs.readFileString(path.join(dir, name, ".oxlintrc.json"));
          const fixture = yield* Schema.decodeUnknownEffect(FixtureConfig)(text);
          const [[rule, setting]] = Object.entries(fixture.rules);

          assert.isDefined(rule);

          assert.strictEqual(
            JSON.stringify(fixture.settings.shadcn),
            JSON.stringify(config.lint?.settings?.shadcn),
            `${name}: settings.shadcn differ from the applied config`,
          );
          assert.notStrictEqual(
            normalize(base[rule]),
            "absent",
            `${name}: ${rule} is not in the applied preset`,
          );
          assert.strictEqual(
            normalize(base[rule]),
            normalize(setting),
            `${name}: ${rule} options differ from the applied preset`,
          );

          if (name.startsWith("shadcn-exempt-")) {
            assert.strictEqual(
              normalize(exempt[rule]),
              '"off"',
              `${name}: ${rule} is not off under ${uiGlob} in the applied preset`,
            );
          }
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
