import { createRouter } from "@tanstack/react-router";
import {
  authMethodsText,
  hydrateAuthMethods,
  hydrateOrphanGrace,
  hydrateStackName,
  orphanGraceText,
  stackNameText,
} from "./runtime.ts";
import { routeTree } from "./route-tree.gen.ts";

/**
 * Build the router of one request on the server or of the page in the browser.
 *
 * The server dehydrates the `AUTH_METHODS` and `STACK_NAME` text so the browser reads the same
 * values.
 *
 * @returns A new router over the generated route tree.
 */
export const getRouter = () =>
  createRouter({
    dehydrate: () => ({
      authMethods: authMethodsText(),
      orphanGrace: orphanGraceText(),
      stackName: stackNameText(),
    }),
    hydrate: ({ authMethods, orphanGrace, stackName }) => {
      hydrateAuthMethods(authMethods);
      hydrateOrphanGrace(orphanGrace);
      hydrateStackName(stackName);
    },
    routeTree,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
