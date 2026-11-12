import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import trees from "./fixtures/footprint-trees.json" with { type: "json" };
import { footprint, importSpecifiers } from "./footprint.ts";

/**
 * A `blocks.json` with one slice, `widgets`, and one attach file.
 */
const manifest = JSON.stringify({
  attachFiles: ["apps/api/src/blocks.ts"],
  blocks: [],
  slices: [{ keep: [], name: "widgets", paths: ["apps/api/src/widgets/**"] }],
});

/**
 * Runs the footprint of the fixture tree `name` with the manifest above.
 */
const measured = (name: keyof typeof trees) =>
  footprint({ ...trees[name], "blocks.json": manifest });

describe("importSpecifiers", () => {
  it("finds static, side-effect, type, re-export, dynamic and require imports with their lines", () => {
    const text = [
      'import a from "./a.ts";',
      'import type { B } from "./b.ts";',
      'import "./c.ts";',
      'export * from "./d.ts";',
      'export { e } from "./e.ts";',
      'const f = import("./f.ts");',
      'import g = require("./g.ts");',
      'const h = require("./h.ts");',
    ].join("\n");

    assert.deepStrictEqual(
      importSpecifiers(text).map((ref) => [ref.specifier, ref.line]),
      [
        ["./a.ts", 1],
        ["./b.ts", 2],
        ["./c.ts", 3],
        ["./d.ts", 4],
        ["./e.ts", 5],
        ["./f.ts", 6],
        ["./g.ts", 7],
        ["./h.ts", 8],
      ],
    );
  });

  it("ignores comments, strings, regular expressions and exports without a source", () => {
    const text = [
      '// import a from "./a.ts";',
      '/* import b from "./b.ts"; */',
      'const c = "import d from \\"./d.ts\\"";',
      `const e = /import "x"/u.test(\`\${1} import "./y.ts"\`);`,
      "export { c };",
      'import real from "./real.ts";',
    ].join("\n");

    assert.deepStrictEqual(
      importSpecifiers(text).map((ref) => ref.specifier),
      ["./real.ts"],
    );
  });
});

describe("footprint", () => {
  it.effect("a clean unit has no failures and one timed line", () =>
    Effect.gen(function* clean() {
      const result = yield* measured("clean");

      assert.deepStrictEqual(result.failures, []);
      assert.match(result.lines.join("\n"), /^widgets: 0 core references, \d+ ms$/u);
    }),
  );

  it.effect("a core file importing the unit fails naming file and line", () =>
    Effect.gen(function* coreImport() {
      const result = yield* measured("core-import");

      assert.deepStrictEqual(result.failures, [
        'apps/api/src/worker.ts:2: core file references widgets via "./widgets/widget.ts"',
      ]);
    }),
  );

  it.effect("an import the pull-out deletes by a block marker is not a core reference", () =>
    Effect.gen(function* marked() {
      assert.deepStrictEqual((yield* measured("marked-import")).failures, []);
    }),
  );

  it.effect("a generated file is not scanned", () =>
    Effect.gen(function* generated() {
      assert.deepStrictEqual((yield* measured("generated-import")).failures, []);
    }),
  );

  it.effect("an attach file may import the unit", () =>
    Effect.gen(function* attachImport() {
      assert.deepStrictEqual((yield* measured("attach-import")).failures, []);
    }),
  );

  it.effect(
    "a block named like its metered package is measured once, over its declared paths",
    () =>
      Effect.gen(function* declared() {
        const result = yield* footprint({
          "blocks.json": JSON.stringify({
            attachFiles: [],
            blocks: [
              {
                name: "gizmo",
                paths: ["packages/gizmo/", "infra/src/gizmo-plan.ts"],
              },
            ],
            slices: [],
          }),
          "infra/src/gizmo-plan.ts": 'import { gizmo } from "../../packages/gizmo/src/stack.ts";\n',
          "packages/gizmo/README.md": "Meter: KV\n\n# Gizmo\n",
          "packages/gizmo/package.json": '{"name":"@workspace/gizmo"}',
          "packages/gizmo/src/stack.ts": "export const gizmo = 1;\n",
        });

        assert.deepStrictEqual(result.failures, []);
        assert.match(result.lines.join("\n"), /^gizmo: 0 core references, \d+ ms$/u);
      }),
  );

  it.effect("an attach file with a dotted list entry fails naming the file, line and form", () =>
    Effect.gen(function* dotted() {
      const result = yield* footprint({
        "apps/api/src/blocks.ts":
          'import { Layer } from "effect";\n\nexport const Attached = Layer.mergeAll(\n  Core,\n  Layer.empty,\n);\n',
        "blocks.json": manifest,
      });

      assert.deepStrictEqual(result.failures, [
        "unknown attach shape apps/api/src/blocks.ts:5: expected one plain identifier per line between `Layer.mergeAll(` and `)`, such as `Name,`",
      ]);
    }),
  );

  it.effect("an owned dependency its manifest does not list fails naming both", () =>
    Effect.gen(function* unlisted() {
      const result = yield* footprint({
        "blocks.json": JSON.stringify({
          attachFiles: [],
          blocks: [],
          slices: [
            {
              dependencies: [{ manifest: "package.json", name: "gone" }],
              keep: [],
              name: "widgets",
              paths: ["apps/api/src/widgets/**"],
            },
          ],
        }),
        "package.json": JSON.stringify({ devDependencies: { effect: "4.1.2" } }),
      });

      assert.deepStrictEqual(result.failures, [
        "blocks.json owns dependency gone but package.json lists none",
      ]);
    }),
  );

  it.effect("an attach file whose list holds only plain identifiers passes", () =>
    Effect.gen(function* plain() {
      const result = yield* footprint({
        "apps/api/src/blocks.ts":
          'import { Layer } from "effect";\n\nexport const Attached = Layer.mergeAll(\n  Core,\n  Extra,\n);\n',
        "blocks.json": manifest,
      });

      assert.deepStrictEqual(result.failures, []);
    }),
  );

  it.effect("a collapsed attach line naming the unit fails with the grammar message", () =>
    Effect.gen(function* collapsed() {
      assert.deepStrictEqual((yield* measured("collapsed")).failures, [
        "collapsed attach line apps/api/src/blocks.ts:3: put widgets on its own line between // block:widgets start and // block:widgets end",
      ]);
    }),
  );
});
