import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands } from "vitest/browser";

/**
 * The result of one axe run on a hydrated page, as the `scan` command in `vite.browser.config.ts`
 * returns it.
 */
interface Scan {
  readonly passes: number;
  readonly text: string;
  readonly violations: ReadonlyArray<{
    readonly id: string;
    readonly impact: string | null;
    readonly nodes: ReadonlyArray<string>;
  }>;
}

declare module "vitest/browser" {
  interface BrowserCommands {
    /**
     * Open a page in a second tab of the browser, wait for React to hydrate it, and run axe-core.
     * A path is served by the production build of `web`; a full URL is opened as it is.
     */
    readonly scan: (target: string, cookie?: string) => Promise<Scan>;
  }
}

/**
 * The first screens. The stub `API` of the harness answers a signed-out caller on the `stub=401`
 * cookie and a signed-in caller otherwise, so the notes list needs no cookie.
 */
const SCREENS = [
  {
    cookie: "stub=401",
    known: [],
    name: "sign-in",
    path: "/sign-in",
    shows: "Use your email and password.",
  },
  {
    cookie: "stub=401",
    known: [],
    name: "sign-up",
    path: "/sign-up",
    shows: "Choose a name, an email",
  },
  {
    cookie: undefined,
    // A real defect, found by this tier: `ItemGroup` renders `role="list"` and each note is a
    // link, not a `listitem`. The screen's own fix removes this entry; until then the check still
    // fails on any other rule, and on this one when it stops firing.
    known: ["aria-required-children"],
    name: "notes list",
    path: "/notes",
    shows: "First note",
  },
] as const;

describe("the first screens", () => {
  for (const { cookie, known, name, path, shows } of SCREENS) {
    it.effect(`${name} has only the known axe violations once hydrated`, () =>
      Effect.gen(function* scanScreen() {
        const { passes, text, violations } = yield* Effect.promise(() =>
          commands.scan(path, cookie),
        );

        assert.include(text, shows);
        assert.isAbove(passes, 0);
        assert.deepStrictEqual(
          violations.map(({ id }) => id),
          [...known],
        );
      }),
    );
  }
});
