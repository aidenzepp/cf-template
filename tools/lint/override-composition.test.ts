import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import config from "../../vite.config.ts";
import { basePaths, restrictImports } from "./rules/restrict-imports.ts";

/**
 * The shape `restrictImports` emits for `no-restricted-imports`: the severity and an options
 * object whose `paths` list the banned imports.
 */
const Restriction = Schema.Tuple([
  Schema.String,
  Schema.Struct({ paths: Schema.Array(Schema.Unknown) }),
]);

/**
 * Reports whether an override either leaves `no-restricted-imports` alone or carries every entry
 * of `base` in its `paths`. A malformed `no-restricted-imports` setting never carries the base.
 */
const carriesBase = (
  override: { rules?: { "no-restricted-imports"?: unknown } },
  base: readonly unknown[],
) => {
  const rule = override.rules?.["no-restricted-imports"];

  if (rule === undefined) {
    return true;
  }

  return Schema.is(Restriction)(rule) && base.every((entry) => rule[1].paths.includes(entry));
};

const sample = [{ message: "sample base entry", name: "effect" }];

describe("no-restricted-imports override composition", () => {
  it("every override in the lint config carries the base paths", () => {
    for (const override of config.lint?.overrides ?? []) {
      assert.isTrue(carriesBase(override, basePaths));
    }
  });

  it("restrictImports output carries the base paths", () => {
    assert.isTrue(carriesBase(restrictImports(["src/**"], { paths: [] }), basePaths));
  });

  it("a raw override fails the predicate", () => {
    const raw = {
      files: ["src/**"],
      rules: { "no-restricted-imports": ["error", { paths: [], patterns: [] }] },
    };

    assert.isFalse(carriesBase(raw, sample));
  });
});
