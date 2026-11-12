import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import config from "../../vite.config.ts";
import {
  authFetchMembers,
  dataAccessMembers,
  globalThisFetch,
  jsonStringifyMember,
  registryMembers,
  runMembers,
} from "./rules/restricted-properties.ts";
import {
  basePaths,
  libraryPatterns,
  libraryPaths,
  nodeBuiltins,
  restrictImports,
} from "./rules/restrict-imports.ts";

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
  base: ReadonlyArray<unknown>,
) => {
  const rule = override.rules?.["no-restricted-imports"];

  if (rule === undefined) {
    return true;
  }

  return Schema.is(Restriction)(rule) && base.every((entry) => rule[1].paths.includes(entry));
};

/**
 * The shape of `restrictImports` options that lists `patterns`.
 */
const Patterned = Schema.Tuple([
  Schema.String,
  Schema.Struct({ patterns: Schema.Array(Schema.Unknown) }),
]);

/**
 * The files globs that name a path under an app's `src`, such as `apps/api/src/worker.ts`.
 */
const underAppSource = (files: ReadonlyArray<string> | undefined) =>
  (files ?? []).some((glob) => /^apps\/[^/]+\/src\//u.test(glob));

const sample = [{ message: "sample base entry", name: "effect" }];

/**
 * Matches a path against a glob made of literal segments, `*` and `**`, the only forms the
 * overrides in `vite.config.ts` use. `**` followed by a slash also matches no directory.
 */
const matchesGlob = (file: string, glob: string) =>
  new RegExp(
    `^${glob
      .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
      .replaceAll("**/", "\u0000")
      .replaceAll("**", "\u0001")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", "(?:.*/)?")
      .replaceAll("\u0001", ".*")}$`,
    "u",
  ).test(file);

/**
 * The effective `no-restricted-properties` setting of a file: the last matching override, as in
 * oxlint, else the root rule.
 */
const effective = (file: string) => {
  let current = config.lint?.rules?.["no-restricted-properties"];

  for (const override of config.lint?.overrides ?? []) {
    const setting = override.rules?.["no-restricted-properties"];

    if (setting !== undefined && (override.files ?? []).some((glob) => matchesGlob(file, glob))) {
      current = setting;
    }
  }

  return current;
};

/**
 * The runtime boundaries, the only overrides allowed to drop the base paths (`base: false`).
 */
const boundaries = new Set([
  "apps/api/src/**/*.test.ts",
  "apps/auth/src/**/*.test.ts",
  "apps/auth/src/auth.ts",
  "apps/web/src/**/*.test.ts",
  "apps/web/src/runtime.ts",
  "apps/web/src/server.ts",
  "packages/*/src/**/*.test.ts",
  "**/*.test.ts",
]);

describe("no-restricted-imports override composition", () => {
  it("every override carries the base paths unless it is a runtime boundary", () => {
    for (const override of config.lint?.overrides ?? []) {
      const files = override.files ?? [];

      const boundary = files.length > 0 && files.every((glob) => boundaries.has(glob));

      assert.isTrue(boundary || carriesBase(override, basePaths), files.join(", "));
    }
  });

  it("every override carries the banned libraries, runtime boundaries included", () => {
    const Full = Schema.Tuple([
      Schema.String,
      Schema.Struct({
        paths: Schema.Array(Schema.Unknown),
        patterns: Schema.Array(Schema.Unknown),
      }),
    ]);

    for (const override of config.lint?.overrides ?? []) {
      const rule = override.rules?.["no-restricted-imports"];

      if (rule !== undefined) {
        assert.isTrue(
          Schema.is(Full)(rule) &&
            libraryPaths.every((entry) => rule[1].paths.includes(entry)) &&
            libraryPatterns.every((entry) => rule[1].patterns.includes(entry)),
          (override.files ?? []).join(", "),
        );
      }
    }
  });

  it("an override that drops the base paths is a listed boundary", () => {
    const dropped = (config.lint?.overrides ?? []).filter(
      (override) =>
        override.rules?.["no-restricted-imports"] !== undefined &&
        !carriesBase(override, basePaths),
    );

    assert.isAbove(dropped.length, 0);

    for (const override of dropped) {
      assert.isTrue((override.files ?? []).every((glob) => boundaries.has(glob)));
    }
  });

  it("every override under apps/*/src carries every R1 group", () => {
    const r1 = (config.lint?.overrides ?? []).find((override) =>
      override.files?.includes("apps/*/src/**"),
    );

    const decoded = Schema.decodeUnknownOption(Patterned)(r1?.rules?.["no-restricted-imports"]);

    assert.isTrue(decoded._tag === "Some");

    // `password.ts` lifts `node:*` and keeps R1; the library bans every override carries are
    // checked by their own test.
    const groups = (decoded._tag === "Some" ? decoded.value[1].patterns : []).filter(
      (pattern) =>
        pattern !== nodeBuiltins && !libraryPatterns.some((library) => library === pattern),
    );

    assert.isAbove(groups.length, 0);

    for (const override of config.lint?.overrides ?? []) {
      const rule = override.rules?.["no-restricted-imports"];

      if (underAppSource(override.files) && rule !== undefined) {
        const carried = Schema.decodeUnknownOption(Patterned)(rule);

        assert.isTrue(carried._tag === "Some");

        const patterns = carried._tag === "Some" ? carried.value[1].patterns : [];

        assert.isTrue(groups.every((group) => patterns.includes(group)));
      }
    }
  });

  it("each listed file ends with the ruled no-restricted-properties list", () => {
    assert.deepStrictEqual(effective("apps/api/src/worker.ts"), [
      "error",
      ...runMembers,
      ...dataAccessMembers,
      ...registryMembers,
    ]);

    assert.strictEqual(effective("apps/api/src/notes.test.ts"), "off");
    assert.deepStrictEqual(effective("apps/web/src/server.test.ts"), ["error", globalThisFetch]);

    assert.deepStrictEqual(effective("apps/auth/src/reclaim.ts"), [
      "error",
      ...runMembers,
      ...registryMembers,
    ]);

    assert.deepStrictEqual(effective("apps/web/src/lib/redirect-target.ts"), [
      "error",
      ...runMembers,
      ...dataAccessMembers,
      ...registryMembers,
      globalThisFetch,
    ]);

    for (const file of ["apps/web/src/runtime.ts", "apps/web/src/server.ts"]) {
      assert.deepStrictEqual(
        effective(file),
        ["error", ...dataAccessMembers, ...registryMembers, globalThisFetch],
        file,
      );
    }

    assert.deepStrictEqual(effective("packages/db/src/batch.ts"), [
      "error",
      ...runMembers,
      ...registryMembers,
    ]);

    assert.strictEqual(effective("apps/auth/src/auth.ts"), "off");
  });

  it("each lifted file keeps every ban but the one it lifts", () => {
    assert.deepStrictEqual(effective("apps/web/src/lib/settings-calls.ts"), [
      "error",
      ...runMembers,
      ...dataAccessMembers,
      jsonStringifyMember,
      globalThisFetch,
    ]);

    for (const file of ["packages/budget-guard/src/latch.ts", "apps/auth/src/test-harness.ts"]) {
      assert.deepStrictEqual(
        effective(file),
        ["error", ...runMembers, ...dataAccessMembers, ...authFetchMembers],
        file,
      );
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
