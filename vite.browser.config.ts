import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import type { AxeResults } from "axe-core";
import type { BrowserContext } from "playwright";
import { defineConfig } from "vite-plus";

const web = fileURLToPath(new URL("apps/web/", import.meta.url));

const outDir = `${web}node_modules/.cache/browser-harness`;

const axeSource = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/**
 * The seeded violation: a test file no include matches, run only by naming it.
 */
const FIXTURE = "test/browser/fixtures/violation.fixture.ts";

/**
 * The WCAG 2.2 A and AA rules of axe-core. Its best-practice rules (a page needs an `h1`, say) are
 * advice, not conformance, and stay out of a blocking check.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * The stub `API`: a session answers `401` on the `stub=401` cookie and a signed-in caller
 * otherwise; the notes list holds one note.
 */
const apiScript = `
export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    const out = /stub=401/.test(request.headers.get("cookie") ?? "");
    if (pathname === "/api/session") {
      return out
        ? new Response("no", { status: 401 })
        : Response.json({ email: "a@b.test", expiresAt: "2030-01-01T00:00:00.000Z", image: null, name: "A", userId: "u1" });
    }
    if (pathname === "/api/notes") {
      return Response.json([{ body: "Body", createdAt: "2030-01-01T00:00:00.000Z", id: "n1", title: "First note", updatedAt: "2030-01-01T00:00:00.000Z" }]);
    }
    return new Response("nope", { status: 404 });
  },
};
`;

const authScript = `export default { fetch: () => new Response("nope", { status: 404 }) };`;

/**
 * The part of Miniflare this file uses.
 */
interface MiniflareModule {
  readonly Miniflare: new (options: { readonly workers: ReadonlyArray<object> }) => {
    readonly dispose: () => Promise<void>;
    readonly ready: Promise<URL>;
  };
}

const hasMiniflare = (module: unknown): module is MiniflareModule =>
  typeof module === "object" && module !== null && "Miniflare" in module;

/**
 * Build the production bundle of `web` and serve it on Miniflare with the stub `API` and `AUTH`,
 * the way `apps/web/src/harness` does.
 *
 * @returns The origin the bundle is served on and the call that stops it.
 */
const startHarness = async () => {
  execFileSync("bun", ["run", "build:prod-harness", "--outDir", outDir], {
    cwd: web,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
  });

  // `miniflare` is a dependency of `apps/web`, not of the root, so it resolves from there.
  const loaded: unknown = createRequire(`${web}package.json`)("miniflare");

  if (!hasMiniflare(loaded)) {
    throw new Error(
      "The miniflare module of apps/web has no Miniflare export. Run bun install and retry.",
    );
  }

  const { Miniflare } = loaded;
  const server = `${outDir}/server`;
  const entries = await readdir(server, { recursive: true });
  const files = entries.filter((file) => file.endsWith(".js"));

  const instance = new Miniflare({
    workers: [
      {
        assets: {
          directory: `${outDir}/client`,
          routerConfig: {
            has_user_worker: true,
            static_routing: { user_worker: ["/api/*", "/auth/*"] },
          },
        },
        bindings: {
          AUTH_METHODS: '{"email":true,"providers":[]}',
          AUTH_ORPHAN_GRACE_SECONDS: "600",
          PUBLIC_ORIGIN: "http://x",
        },
        compatibilityDate: "2026-10-26",
        modules: files.map((file) => ({ path: `${server}/${file}`, type: "ESModule" })),
        modulesRoot: server,
        name: "web",
        serviceBindings: { API: "api", AUTH: "auth" },
      },
      { compatibilityDate: "2026-10-26", modules: true, name: "api", script: apiScript },
      { compatibilityDate: "2026-10-26", modules: true, name: "auth", script: authScript },
    ],
  });

  const { origin } = await instance.ready;

  return { dispose: () => instance.dispose(), origin };
};

/**
 * The browser tier's Node side: the `scan` command, and the call that stops the harness it started.
 * The harness starts on the first scan of a path, so a run of full URLs builds nothing.
 */
const makeTier = () => {
  let harness: ReturnType<typeof startHarness> | undefined;

  /**
   * Open `target` in a second tab, wait for React to hydrate it, and run axe-core on it.
   *
   * @param ctx - The command context.
   * @param ctx.context - The Playwright browser context of the test run.
   * @param target - A path on the harness, or a full URL.
   * @param cookie - A `name=value` cookie to send to the harness.
   * @returns The count of passed rules, the violations and the visible text of the page.
   */
  const scan = async (
    { context }: { readonly context: BrowserContext },
    target: string,
    cookie?: string,
  ) => {
    const isPath = target.startsWith("/");

    harness ??= startHarness();

    const { origin } = isPath ? await harness : { origin: "" };
    const page = await context.newPage();

    await context.clearCookies();

    if (cookie !== undefined) {
      const [name = "", value = ""] = cookie.split("=");

      await context.addCookies([{ name, url: origin, value }]);
    }

    await page.goto(isPath ? `${origin}${target}` : target, { waitUntil: "networkidle" });

    if (isPath) {
      await page.waitForFunction(() =>
        [...document.querySelectorAll("*")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactFiber")),
        ),
      );
    }

    await page.addScriptTag({ path: axeSource });

    const { passes, violations } = await page.evaluate<AxeResults>(
      `axe.run({ runOnly: { type: "tag", values: ${JSON.stringify(WCAG_TAGS)} } })`,
    );

    const texts = await page.locator("body").allInnerTexts();

    await page.close();

    return {
      passes: passes.length,
      text: texts.join("\n"),
      violations: violations.map(({ id, impact, nodes }) => ({
        id,
        impact: impact ?? null,
        nodes: nodes.map(({ html, target: selector }) => `${selector.join(" ")}: ${html}`),
      })),
    };
  };

  const dispose = async () => {
    const started = await harness;

    await started?.dispose();
  };

  return { dispose, scan };
};

const { dispose, scan } = makeTier();

// The `browser` tier: axe-core against the hydrated first screens, in a real browser. Vitest 5's
// Playwright provider drives it; the page under test is the production build of `web`, so the
// `scan` command opens it in a second tab. `ALCHEMY_TEST_DEV` is the root block's deploy guard and
// is set here for the same reason, because this config does not extend `vite.config.ts`.
export default defineConfig({
  plugins: [
    {
      configureServer: (server) => {
        server.httpServer?.once("close", () => {
          void dispose();
        });
      },
      name: "stop-browser-harness",
    },
  ],
  test: {
    allowOnly: false,
    browser: {
      commands: { scan },
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
