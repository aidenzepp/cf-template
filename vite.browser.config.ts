import { playwright } from "@vitest/browser-playwright";
import type { BrowserContext } from "playwright";
import { defineConfig } from "vite-plus";
import { scanPage, stopHarness } from "./test/browser/support/browser-harness.ts";

/**
 * The seeded violation: a test file no include matches, run only by naming it.
 */
const FIXTURE = "test/browser/fixtures/violation.fixture.ts";

// The `browser` tier: axe-core against the hydrated first screens, in a real browser. Vitest 5's
// Playwright provider drives it; the page under test is the production build of `web`, so the
// `scan` command opens it in a second tab (`test/browser/support/browser-harness.ts`).
// `ALCHEMY_TEST_DEV` is the root block's deploy guard and is set here for the same reason, because
// this config does not extend `vite.config.ts`.
export default defineConfig({
  plugins: [
    {
      configureServer: (server) => {
        server.httpServer?.once("close", () => {
          void stopHarness();
        });
      },
      name: "stop-browser-harness",
    },
  ],
  test: {
    allowOnly: false,
    browser: {
      commands: {
        scan: (
          { context }: { readonly context: BrowserContext },
          target: string,
          cookie?: string,
        ) => scanPage(context, target, cookie),
      },
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
      screenshotFailures: false,
    },
    env: { ALCHEMY_TEST_DEV: "1" },
    // The seeded violation joins the include only when the command line names it, so no other run
    // reaches it and the `browser` job is never red by construction.
    include: ["test/browser/**/*.browser.ts", ...(process.argv.includes(FIXTURE) ? [FIXTURE] : [])],
    testTimeout: 120_000,
  },
});
