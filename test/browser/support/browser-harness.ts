import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, ManagedRuntime, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { BrowserContext } from "playwright";
import type { AxeResults } from "axe-core";
import { resolveStackName } from "../../../infra/src/stack-name.ts";

/**
 * The WCAG 2.2 A and AA rules of axe-core. Its best-practice rules (a page needs an `h1`, say) are
 * advice, not conformance, and stay out of a blocking check.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * The viewport widths a scan screenshots the page at, and the viewport height it sets for them. The
 * screenshot covers the full page, so the height only decides what is above the fold.
 */
const SCREENSHOT_WIDTHS = [390, 1280] as const;

const SCREENSHOT_HEIGHT = 900;

/**
 * True once React has hydrated a node of the page: hydrated nodes carry a `__reactFiber` key.
 */
export const HYDRATED = `[...document.querySelectorAll("*")].some((element) =>
  Object.keys(element).some((key) => key.startsWith("__reactFiber")),
)`;

/**
 * The stub `API`: a session answers `401` on the `stub=401` cookie and a signed-in caller
 * otherwise.
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
    return new Response("nope", { status: 404 });
  },
};
`;

const authScript = `export default { fetch: () => new Response("nope", { status: 404 }) };`;

/**
 * The failure of the harness or of a browser step: the build, Miniflare, or Playwright did not
 * complete.
 */
class BrowserTierFailed extends Schema.TaggedError<BrowserTierFailed>()("BrowserTierFailed", {
  message: Schema.String,
}) {}

/**
 * The part of Miniflare this module uses.
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
 * Run one Promise-based step of Playwright or Miniflare as an Effect.
 *
 * @param what - What the step does, for the failure message.
 * @param step - The step.
 * @returns The step's result, or a {@link BrowserTierFailed}.
 */
export const promised = <A>(what: string, step: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new BrowserTierFailed({ message: `${what} failed: ${String(cause)}.` }),
    try: step,
  });

/**
 * The origin of the production build of `web`, served on Miniflare, and the stack name it binds as
 * `STACK_NAME`: the one `resolveStackName` derives for a deploy of this checkout.
 */
export class Harness extends Context.Service<
  Harness,
  { readonly origin: string; readonly stackName: string }
>()("@workspace/test/BrowserHarness") {}

const MiniflarePackage = Schema.fromJsonString(Schema.Struct({ main: Schema.String }));

/**
 * Build the production bundle of `web` and serve it on Miniflare with the stub `API` and `AUTH`,
 * the way `apps/web/src/harness` does. The layer builds once per runtime and stops Miniflare when
 * the runtime is disposed.
 */
const HarnessLive = Layer.effect(Harness)(
  Effect.gen(function* start() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* path.fromFileUrl(new URL("../../../", import.meta.url));
    const web = path.join(root, "apps", "web");
    const stackName = yield* resolveStackName();
    const outDir = path.join(web, "node_modules", ".cache", "browser-harness");

    const code = yield* spawner.exitCode(
      ChildProcess.make("bun", ["run", "build:prod-harness", "--outDir", outDir], {
        cwd: web,
        stderr: "ignore",
        stdout: "ignore",
      }),
    );

    if (code !== 0) {
      return yield* new BrowserTierFailed({
        message: `The web build exited with code ${code}. Run bun run build:prod-harness in apps/web.`,
      });
    }

    // `miniflare` is a dependency of `apps/web`, not of the root, so it resolves from there.
    const miniflare = path.join(web, "node_modules", "miniflare");

    const { main } = yield* fs
      .readFileString(path.join(miniflare, "package.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MiniflarePackage)));

    const entry = yield* path.toFileUrl(path.join(miniflare, main));
    const loaded: unknown = yield* promised("Loading miniflare", () => import(entry.href));

    if (!hasMiniflare(loaded)) {
      return yield* new BrowserTierFailed({
        message: "The miniflare module of apps/web has no Miniflare export. Run bun install.",
      });
    }

    const server = path.join(outDir, "server");
    const entries = yield* fs.readDirectory(server, { recursive: true });
    const files = entries.filter((file) => file.endsWith(".js"));

    const instance = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new loaded.Miniflare({
            workers: [
              {
                assets: {
                  directory: path.join(outDir, "client"),
                  routerConfig: {
                    has_user_worker: true,
                    static_routing: { user_worker: ["/api/*", "/auth/*"] },
                  },
                },
                bindings: {
                  AUTH_METHODS: '{"email":true,"providers":[]}',
                  AUTH_ORPHAN_GRACE_SECONDS: "600",
                  PUBLIC_ORIGIN: "http://x",
                  STACK_NAME: stackName,
                },
                compatibilityDate: "2026-10-26",
                modules: files.map((file) => ({
                  path: path.join(server, file),
                  type: "ESModule",
                })),
                modulesRoot: server,
                name: "web",
                serviceBindings: { API: "api", AUTH: "auth" },
              },
              { compatibilityDate: "2026-10-26", modules: true, name: "api", script: apiScript },
              { compatibilityDate: "2026-10-26", modules: true, name: "auth", script: authScript },
            ],
          }),
      ),
      (running) => Effect.promise(() => running.dispose()),
    );

    const { origin } = yield* promised("Starting Miniflare", () => instance.ready);

    return Harness.of({ origin, stackName });
  }),
).pipe(Layer.provide(BunServices.layer));

const runtime = ManagedRuntime.make(Layer.mergeAll(HarnessLive, BunServices.layer));

/**
 * Open `target` in a second tab, wait for React to hydrate it, and run axe-core on it.
 *
 * @param context - The Playwright browser context of the test run.
 * @param target - A path on the harness, or a full URL.
 * @param cookie - A `name=value` cookie to send to the harness.
 * @param colorScheme - The `prefers-color-scheme` to emulate.
 * @returns The count of passed rules, the violations, the visible text of the page, the stack name
 *   the harness binds (empty for a full URL) and, on Linux, a
 *   full-page PNG at each of {@link SCREENSHOT_WIDTHS}. The baselines are Linux screenshots, so no
 *   other platform takes one.
 */
const scan = Effect.fn("scan")(function* scan(
  context: BrowserContext,
  target: string,
  cookie: string | undefined,
  colorScheme: "light" | "dark",
) {
  const path = yield* Path.Path;
  const isPath = target.startsWith("/");
  const { origin, stackName } = isPath ? yield* Harness : { origin: "", stackName: "" };
  const axeSource = yield* path.fromFileUrl(new URL(import.meta.resolve("axe-core/axe.min.js")));

  return yield* Effect.gen(function* inPage() {
    const page = yield* Effect.acquireRelease(
      promised("Opening a tab", () => context.newPage()),
      (opened) => Effect.promise(() => opened.close()),
    );

    yield* promised("Emulating the color scheme", () => page.emulateMedia({ colorScheme }));

    yield* promised("Clearing cookies", () => context.clearCookies());

    if (cookie !== undefined) {
      const [name = "", value = ""] = cookie.split("=");

      yield* promised("Setting the cookie", () =>
        context.addCookies([{ name, url: origin, value }]),
      );
    }

    yield* promised("Loading the page", () =>
      page.goto(isPath ? `${origin}${target}` : target, { waitUntil: "networkidle" }),
    );

    if (isPath) {
      yield* promised("Waiting for hydration", () => page.waitForFunction(HYDRATED));
    }

    yield* promised("Injecting axe-core", () => page.addScriptTag({ path: axeSource }));

    const { passes, violations } = yield* promised("Running axe-core", () =>
      page.evaluate<AxeResults>(
        `axe.run({ runOnly: { type: "tag", values: ${JSON.stringify(WCAG_TAGS)} } })`,
      ),
    );

    const texts = yield* promised("Reading the page text", () =>
      page.locator("body").allInnerTexts(),
    );

    const dark = yield* promised("Reading the theme class", () =>
      page.evaluate<boolean>(`document.documentElement.classList.contains("dark")`),
    );

    // Screenshots last: resizing the viewport must not change what axe-core and the text read saw.
    const widths = process.platform === "linux" ? SCREENSHOT_WIDTHS : [];

    const screenshots = yield* Effect.all(
      widths.map((width) =>
        Effect.gen(function* screenshotAt() {
          yield* promised(`Resizing to ${width}px`, () =>
            page.setViewportSize({ height: SCREENSHOT_HEIGHT, width }),
          );

          const png = yield* promised(`Screenshotting at ${width}px`, () =>
            page.screenshot({ animations: "disabled", caret: "hide", fullPage: true }),
          );

          return { png: png.toString("base64"), width };
        }),
      ),
    );

    return {
      dark,
      passes: passes.length,
      screenshots,
      stackName,
      text: texts.join("\n"),
      violations: violations.map(({ id, impact, nodes }) => ({
        id,
        impact: impact ?? null,
        nodes: nodes.map(({ html, target: selector }) => `${selector.join(" ")}: ${html}`),
      })),
    };
  }).pipe(Effect.scoped);
});

/**
 * The `scan` browser command, at the Vitest boundary: Vitest calls a plain function and awaits its
 * Promise.
 *
 * @param context - The Playwright browser context of the test run.
 * @param target - A path on the harness, or a full URL.
 * @param cookie - A `name=value` cookie to send to the harness.
 * @param colorScheme - The `prefers-color-scheme` to emulate.
 * @returns A promise of the scan.
 */
export const scanPage = (
  context: BrowserContext,
  target: string,
  cookie: string | undefined,
  colorScheme: "light" | "dark",
) => runtime.runPromise(scan(context, target, cookie, colorScheme));

/**
 * Run a browser command of the harness at the Vitest boundary: Vitest calls a plain function and
 * awaits its Promise. The `audit` command of `test/browser/support/style-audit.ts` runs here, so it
 * shares the harness this module builds.
 *
 * @param effect - The command, needing the harness or the Bun services.
 * @returns A promise of the command's result.
 */
export const runInHarness = <A, E>(
  effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
) => runtime.runPromise(effect);

/**
 * Stop the harness, if a scan started it.
 *
 * @returns A promise that settles once Miniflare has stopped.
 */
export const stopHarness = () => runtime.dispose();
