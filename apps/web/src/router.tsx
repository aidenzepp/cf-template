import { createRouter } from "@tanstack/react-router";
import { RouteError } from "./components/errors/error.tsx";
import {
  authMethodsText,
  hydrateAuthMethods,
  hydrateOrphanGrace,
  orphanGraceText,
} from "./runtime.ts";
import { routeTree } from "./route-tree.gen.ts";

/**
 * Build the router of one request on the server or of the page in the browser.
 *
 * The server dehydrates the `AUTH_METHODS` text so the browser's runtime decodes the same value.
 *
 * @returns A new router over the generated route tree.
 */
export const getRouter = () =>
  createRouter({
    // A route's own error boundary falls back to this, not to the root's `errorComponent`, so a
    // child route's loader failure gets the same designed page.
    defaultErrorComponent: RouteError,
    dehydrate: () => ({ authMethods: authMethodsText(), orphanGrace: orphanGraceText() }),
    hydrate: ({ authMethods, orphanGrace }) => {
      hydrateAuthMethods(authMethods);
      hydrateOrphanGrace(orphanGrace);
    },
    routeTree,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
