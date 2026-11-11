import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import { WEB_DEV_PORT } from "@workspace/config/public-origin";

const harnessRoutes = process.env.WEB_HARNESS_ROUTES === "1";

// The harness build writes its route tree here, so it never rewrites the committed
// `src/route-tree.gen.ts` that a parallel production build reads.
const HARNESS_TREE = "node_modules/.cache/web-harness/route-tree.gen.ts";

export default defineConfig({
  environments: {
    ssr: {
      // The bundle runs on workerd: it carries its dependencies, takes the `workerd` export
      // conditions and imports only the runtime's own `cloudflare:` and `node:` modules.
      build: {
        rolldownOptions: {
          external: ["cloudflare:workers", /^node:/u],
          output: { inlineDynamicImports: true },
          platform: "neutral",
        },
      },
      resolve: {
        conditions: ["workerd", "worker", "module", "import", "default"],
        noExternal: true,
      },
    },
  },
  plugins: [
    tanstackStart({
      router: {
        generatedRouteTree: harnessRoutes ? `../${HARNESS_TREE}` : "route-tree.gen.ts",
        // The harness build (`WEB_HARNESS_ROUTES=1`) registers the `-harness-throws.tsx` fixture and
        // still ignores every other `-` file.
        routeFileIgnorePattern: harnessRoutes ? String.raw`^-(?!harness-throws\.tsx$)` : undefined,
        routeFileIgnorePrefix: harnessRoutes ? "" : "-",
      },
      server: { entry: "server.ts" },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: harnessRoutes
      ? [
          {
            find: /^\.\/route-tree\.gen\.ts$/u,
            replacement: new URL(HARNESS_TREE, import.meta.url).pathname,
          },
        ]
      : [],
    tsconfigPaths: true,
  },
  server: { port: WEB_DEV_PORT, strictPort: true },
});
