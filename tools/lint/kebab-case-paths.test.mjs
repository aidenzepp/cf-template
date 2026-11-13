import { expect, test } from "bun:test";
import { kebabCaseViolations } from "./kebab-case-paths.mjs";

test("allows kebab-case directories", () => {
  expect(kebabCaseViolations("src/schema/element-codec.ts")).toEqual([]);
  expect(kebabCaseViolations("src/decode/namespace-scope/resolve.test.ts")).toEqual([]);
  expect(kebabCaseViolations("vite.config.ts")).toEqual([]);
  expect(kebabCaseViolations("tools/lint/no-built-in-try-catch.mjs")).toEqual([]);
});

test("reports PascalCase, camelCase, and snake_case directories", () => {
  expect(kebabCaseViolations("src/Schema/element.ts")).toEqual(["Schema"]);
  expect(kebabCaseViolations("src/namespaceScope/resolve.ts")).toEqual(["namespaceScope"]);
  expect(kebabCaseViolations("src/element_codec/index.ts")).toEqual(["element_codec"]);
});

test("leaves filenames to unicorn/filename-case", () => {
  expect(kebabCaseViolations("src/schema/ElementCodec.ts")).toEqual([]);
  expect(kebabCaseViolations("src/decode/namespaceScope.ts")).toEqual([]);
});

test("ignores dependency and virtual paths", () => {
  expect(kebabCaseViolations("node_modules/effect/AGENTS.md")).toEqual([]);
  expect(kebabCaseViolations("<input>")).toEqual([]);
  expect(kebabCaseViolations("")).toEqual([]);
});
