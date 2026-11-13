import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands } from "vite-plus/test/browser";
import type { BrowserCommands } from "vite-plus/test/internal/browser";
import { VIOLATIONS } from "./fixtures/style-audit/violations.ts";

/**
 * The result of one axe run on a hydrated page, as the `scan` command in `vite.browser.config.ts`
 * returns it.
 */
interface Scan {
  readonly dark: boolean;
  readonly passes: number;
  readonly text: string;
  readonly violations: ReadonlyArray<{
    readonly id: string;
    readonly impact: string | null;
    readonly nodes: ReadonlyArray<string>;
  }>;
}

/**
 * A `prefers-color-scheme` the scan emulates.
 */
type ColorScheme = "light" | "dark";

/**
 * The `scan` command of `vite.browser.config.ts`: open a page in a second tab, wait for React to
 * hydrate it, and run axe-core. A path is served by the production build of `web`. The command is
 * custom, so the typed `commands` object does not name it.
 */
interface ScanCommand {
  readonly scan: (
    target: string,
    cookie: string | undefined,
    colorScheme: ColorScheme,
  ) => Promise<Scan>;
}

/**
 * The result of one style audit, as the `audit` command in `vite.browser.config.ts` returns it.
 */
interface Audit {
  readonly dark: boolean;
  readonly findings: ReadonlyArray<{
    readonly element: string;
    readonly rule: string;
    readonly value: string;
  }>;
}

/**
 * The `audit` command of `vite.browser.config.ts` (`test/browser/support/style-audit.ts`): open a
 * page in a second tab, optionally add a violation fixture, and audit its computed styles at 390
 * and 1280 px. The command is custom, so the typed `commands` object does not name it.
 */
interface AuditCommand {
  readonly audit: (
    target: string,
    cookie: string | undefined,
    colorScheme: ColorScheme,
    inject: string | undefined,
  ) => Promise<Audit>;
}

const hasAudit = (candidate: BrowserCommands): candidate is BrowserCommands & AuditCommand =>
  "audit" in candidate;

const audit = Effect.fn("audit")(function* audit(
  path: string,
  cookie: string | undefined,
  colorScheme: ColorScheme,
  inject: string | undefined,
) {
  if (!hasAudit(commands)) {
    return yield* Effect.die("The audit command is missing. Check vite.browser.config.ts.");
  }

  const auditor: AuditCommand = commands;

  return yield* Effect.promise(() => auditor.audit(path, cookie, colorScheme, inject));
});

/**
 * A finding as one line: the rule, the element and the value.
 *
 * @param finding - A finding of the audit.
 * @returns The line.
 */
const line = ({ element, rule, value }: Audit["findings"][number]) =>
  `${rule}: ${element}: ${value}`;

const hasScan = (candidate: BrowserCommands): candidate is BrowserCommands & ScanCommand =>
  "scan" in candidate;

const scan = Effect.fn("scan")(function* scan(
  path: string,
  cookie: string | undefined,
  colorScheme: ColorScheme,
) {
  if (!hasScan(commands)) {
    return yield* Effect.die("The scan command is missing. Check vite.browser.config.ts.");
  }

  const scanner: ScanCommand = commands;

  return yield* Effect.promise(() => scanner.scan(path, cookie, colorScheme));
});

/**
 * The first screens: the placeholder index. The stub `API` of the harness answers a signed-in
 * caller without the `stub=401` cookie.
 */
const SCREENS = [
  {
    cookie: undefined,
    name: "placeholder index",
    path: "/",
    shows: "typescript-template",
  },
] as const;

const SCHEMES = ["light", "dark"] as const;

describe("the first screens", () => {
  for (const colorScheme of SCHEMES) {
    for (const { cookie, name, path, shows } of SCREENS) {
      it.effect(`${name} has no axe violations once hydrated in ${colorScheme}`, () =>
        Effect.gen(function* scanScreen() {
          const { dark, passes, text, violations } = yield* scan(path, cookie, colorScheme);

          assert.include(text, shows);
          assert.isAbove(passes, 0);
          assert.strictEqual(dark, colorScheme === "dark");
          assert.deepStrictEqual(
            violations.map(({ id }) => id),
            [],
          );
        }),
      );

      it.effect(`${name} passes the style audit in ${colorScheme}`, () =>
        Effect.gen(function* auditScreen() {
          const { dark, findings } = yield* audit(path, cookie, colorScheme, undefined);

          assert.strictEqual(dark, colorScheme === "dark");
          assert.deepStrictEqual(findings.map(line), []);
        }),
      );
    }

    for (const { html, name, rule } of VIOLATIONS) {
      it.effect(`the style audit flags ${name} once in ${colorScheme}`, () =>
        Effect.gen(function* auditFixture() {
          const { findings } = yield* audit("/", undefined, colorScheme, html);

          assert.deepStrictEqual(
            findings.map(({ rule: broken }) => broken),
            [rule],
            findings.map(line).join("\n"),
          );
        }),
      );
    }
  }
});
