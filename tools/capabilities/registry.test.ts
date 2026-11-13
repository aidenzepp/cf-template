import { BunServices } from "@effect/platform-bun";

import { assert, describe, it } from "@effect/vitest";

import { Array as Arr, Effect, FileSystem, Order, Path, Schema } from "effect";

import config from "../../vite.config.ts";

/**
 * The guards `docs/capabilities.md` marks as pending, as `A<n> <rule key>`. Each lint PR of work
 * order A removes its entries here when it configures the rule and drops the marker from the row.
 */
const pendingGuards: ReadonlyArray<string> = [
  "A2 no-console",
  "A2 no-restricted-globals",
  "A2 no-restricted-imports",
  "A2 no-restricted-properties",
  "A3 workspace/no-effect-data-load",
  "A3 workspace/no-effect-on-async-result",
  "A3 workspace/no-hand-built-problem",
  "A3 workspace/no-hand-rolled-retry",
  "A3 workspace/no-keyed-ttl-map",
  "A3 workspace/no-raw-form-submit",
  "A4 no-restricted-imports",
  "A4 no-restricted-properties",
  "A4 react-doctor/no-collapse-request-error-to-empty-state",
  "A4 react-doctor/tanstack-start-no-direct-fetch-in-loader",
];

/**
 * A guard cell item that names a rule a later PR adds: `pending A<n> \`rule/key\``.
 */
const pendingItem = /pending (?<phase>A[2-4]) `(?<key>[^`]+)`/gu;

/**
 * One backticked rule key.
 */
const ruleKey = /`(?<key>[^`]+)`/gu;

/**
 * One registry row: the concern and the guard cell, split into configured and pending keys.
 */
interface Row {
  readonly concern: string;
  readonly guard: string;
  readonly keys: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
}

/**
 * Reads the rows of the registry table: the lines after the `Concern` header and its separator.
 * A cell is split on every `|` that is not escaped as `\|`.
 */
const parseRows = (text: string): ReadonlyArray<Row> =>
  text
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("| ") && !line.startsWith("| Concern ") && !line.startsWith("| ---"),
    )
    .map((line) => {
      const cells = line
        .replaceAll(/^\||\|$/gu, "")
        .split(/(?<!\\)\|/u)
        .map((cell) => cell.trim());

      const guard = cells[2] ?? "";

      const pending = [...guard.matchAll(pendingItem)].map(
        ({ groups }) => `${groups?.phase ?? ""} ${groups?.key ?? ""}`,
      );

      const keys = [...guard.replaceAll(pendingItem, "").matchAll(ruleKey)].map(
        ({ groups }) => groups?.key ?? "",
      );

      return { concern: cells[0] ?? "", guard, keys, pending };
    });

/**
 * One rule setting of the repository's own lint configuration.
 */
type RuleSetting = NonNullable<NonNullable<typeof config.lint>["rules"]>[string];

/**
 * Whether one rule setting turns the rule on: a severity of `off` or `0`, bare or first in an
 * array, leaves it off.
 */
const isOn = (setting: RuleSetting): boolean => {
  const level = Schema.is(Schema.Array(Schema.Unknown))(setting) ? setting[0] : setting;

  return level !== "off" && level !== 0;
};

/**
 * The rule keys the lint configuration turns on, at the base or in any override.
 */
const configuredKeys = (): ReadonlySet<string> => {
  const { lint } = config;
  const settings = [lint?.rules, ...(lint?.overrides ?? []).map((override) => override.rules)];

  return new Set(
    settings.flatMap((rules) =>
      Object.entries(rules ?? {})
        .filter(([, setting]) => isOn(setting))
        .map(([key]) => key),
    ),
  );
};

/**
 * Reads `docs/capabilities.md` from the repository root.
 */
const readRegistry = Effect.gen(function* readRegistry() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  return yield* fs.readFileString(path.join(root, "docs", "capabilities.md"));
}).pipe(Effect.provide(BunServices.layer));

describe("capability registry", () => {
  it.effect("every row names a guard, and each concern appears once", () =>
    Effect.gen(function* rows() {
      const parsed = parseRows(yield* readRegistry);

      assert.isAbove(parsed.length, 0);

      for (const row of parsed) {
        assert.isTrue(
          row.guard === "none" || row.keys.length + row.pending.length > 0,
          `${row.concern}: the guard is \`none\`, a rule key or a pending marker`,
        );
      }

      assert.strictEqual(new Set(parsed.map((row) => row.concern)).size, parsed.length);
    }),
  );

  it.effect("every named guard rule is configured in vite.config.ts", () =>
    Effect.gen(function* guards() {
      const configured = configuredKeys();

      for (const row of parseRows(yield* readRegistry)) {
        for (const key of row.keys) {
          assert.isTrue(configured.has(key), `${row.concern}: ${key} is not configured`);
        }
      }
    }),
  );

  it.effect("pending guards are exactly the listed ones", () =>
    Effect.gen(function* pending() {
      const found = parseRows(yield* readRegistry).flatMap((row) => row.pending);

      assert.deepStrictEqual(
        Arr.sort(new Set(found), Order.String),
        Arr.sort(pendingGuards, Order.String),
      );
    }),
  );
});
