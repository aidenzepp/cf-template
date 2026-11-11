import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import { WEB_DEV_PORT } from "@workspace/config/public-origin";

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
      router: { generatedRouteTree: "route-tree.gen.ts" },
      server: { entry: "server.ts" },
    }),
  ],
  resolve: { tsconfigPaths: true },
  server: { port: WEB_DEV_PORT, strictPort: true },
});
