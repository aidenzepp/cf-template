import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { WEB_DEV_PORT } from "@workspace/config/public-origin";

const harnessRoutes = process.env.WEB_HARNESS_ROUTES === "1";

// The harness build writes its route tree here, so it never rewrites the committed
// `src/route-tree.gen.ts` that a parallel production build reads.
const HARNESS_TREE = "node_modules/.cache/web-harness/route-tree.gen.ts";

/**
 * Hands the client chunk graph (file, entry flag and static imports of each chunk) to
 * `tools/bundle/check.ts` as `dist/server/.vite/chunk-graph.json`. The client build runs first; the
 * SSR build emits what it recorded. The `.vite/` prefix keeps it out of the Worker upload (Alchemy
 * skips `.vite/*` in the server output). The graph stays out of `dist/client`, the Worker
 * static-asset directory: Vite's own `build.manifest` writes `dist/client/.vite/manifest.json`
 * there, and the deploy runs this same config, so the manifest would be served publicly.
 */
const chunkGraph = (): Plugin => {
  let client = "{}";

  return {
    generateBundle(_options, bundle) {
      if (this.environment.name === "client") {
        client = JSON.stringify(
          Object.fromEntries(
            Object.values(bundle).flatMap((output) =>
              output.type === "chunk"
                ? [
                    [
                      output.fileName,
                      { file: output.fileName, imports: output.imports, isEntry: output.isEntry },
                    ],
                  ]
                : [],
            ),
          ),
        );
      } else if (this.environment.name === "ssr") {
        this.emitFile({ fileName: ".vite/chunk-graph.json", source: client, type: "asset" });
      }
    },
    name: "chunk-graph",
  };
};

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
    chunkGraph(),
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
    // TanStack Start documents the React plugin after `tanstackStart()`. The compiler runs through
    // Babel: `@vitejs/plugin-react` 6 marks its own `compiler` option (a Rust port) experimental.
    react(),
    babel({ presets: [reactCompilerPreset()] }),
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
