import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./route-tree.gen.ts";

/**
 * Build the router of one request on the server or of the page in the browser.
 *
 * @returns A new router over the generated route tree.
 */
export const getRouter = () => createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
