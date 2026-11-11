import { createRouter } from "@tanstack/react-router";
import { authMethodsText, hydrateAuthMethods } from "./runtime.ts";
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
    dehydrate: () => ({ authMethods: authMethodsText() }),
    hydrate: ({ authMethods }) => {
      hydrateAuthMethods(authMethods);
    },
    routeTree,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
