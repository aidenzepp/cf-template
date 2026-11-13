import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands, page, server } from "vite-plus/test/browser";
import type { BrowserCommands } from "vite-plus/test/internal/browser";
import { VIOLATIONS } from "./fixtures/style-audit/violations.ts";

/**
 * The result of one axe run on a hydrated page, as the `scan` command in `vite.browser.config.ts`
 * returns it.
 */
interface Scan {
  readonly dark: boolean;
  readonly passes: number;
  readonly screenshots: ReadonlyArray<{ readonly png: string; readonly width: number }>;
  readonly stackName: string;
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
 * The part of an `img` element `matchScreenshot` uses. The project's `lib` has no DOM types, and
 * this file runs in the browser.
 */
interface ShownImage {
  alt: string;
  readonly decode: () => Promise<void>;
  readonly naturalHeight: number;
  readonly naturalWidth: number;
  readonly remove: () => void;
  src: string;
  readonly style: { cssText: string };
}

/**
 * The part of the browser `document` `matchScreenshot` uses.
 */
declare const document: {
  readonly body: { readonly append: (node: ShownImage) => void };
  readonly createElement: (tag: "img") => ShownImage;
};

/**
 * Compare a PNG of the scanned tab with its baseline in `__screenshots__/`. `toMatchScreenshot`
 * captures the test frame, not the second tab the scan opened, so the PNG is shown in the test
 * frame at its own size and that image is captured.
 *
 * @param name - The baseline name.
 * @param png - The base64 PNG the scan took.
 */
const matchScreenshot = Effect.fn("matchScreenshot")(function* matchScreenshot(
  name: string,
  png: string,
) {
  const image = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const shown = document.createElement("img");

      shown.alt = name;
      shown.src = `data:image/png;base64,${png}`;
      shown.style.cssText = "display: block; left: 0; position: fixed; top: 0;";
      document.body.append(shown);

      return shown;
    }),
    (shown) =>
      Effect.sync(() => {
        shown.remove();
      }),
  );

  yield* Effect.promise(() => image.decode());
  yield* Effect.promise(() => page.viewport(image.naturalWidth, image.naturalHeight));
  yield* Effect.promise(async () => {
    await expect.element(image).toMatchScreenshot(name);
  });
}, Effect.scoped);

/**
 * The first screens: the placeholder index, titled with the stack name the harness binds. The stub
 * `API` of the harness answers a signed-in caller without the `stub=401` cookie.
 */
const SCREENS = [
  {
    cookie: undefined,
    name: "placeholder index",
    path: "/",
    slug: "placeholder-index",
  },
] as const;

const SCHEMES = ["light", "dark"] as const;

describe("the first screens", () => {
  for (const colorScheme of SCHEMES) {
    for (const { cookie, name, path, slug } of SCREENS) {
      it.effect(`${name} has no axe violations once hydrated in ${colorScheme}`, () =>
        Effect.gen(function* scanScreen() {
          const { dark, passes, stackName, text, violations } = yield* scan(
            path,
            cookie,
            colorScheme,
          );

          assert.isNotEmpty(stackName);
          assert.include(text, stackName);
          assert.isAbove(passes, 0);
          assert.strictEqual(dark, colorScheme === "dark");
          assert.deepStrictEqual(
            violations.map(({ id }) => id),
            [],
          );
        }),
      );

      // The baselines are Linux screenshots, written by `.github/workflows/browser-baselines.yml`.
      it.effect.skipIf(server.platform !== "linux")(
        `${name} matches its screenshots at 390 and 1280 px in ${colorScheme}`,
        () =>
          Effect.gen(function* compareScreen() {
            const { screenshots } = yield* scan(path, cookie, colorScheme);

            assert.deepStrictEqual(
              screenshots.map(({ width }) => width),
              [390, 1280],
            );

            for (const { png, width } of screenshots) {
              yield* matchScreenshot(`${slug}-${colorScheme}-${width}`, png);
            }
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
