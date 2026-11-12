import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.tsx";

/**
 * The protected page the harness reloads. It has no guard of its own: the root `beforeLoad` guards
 * it. The `-` prefix keeps the file out of the production route tree.
 *
 * @returns The page body.
 */
const Protected = () => <main data-testid="harness-protected">protected</main>;

/**
 * The route the production harness build registers; the router generator reads this file, no
 * module imports it.
 *
 * @public
 */
export const harnessProtectedRoute = createRoute({
  component: Protected,
  getParentRoute: () => rootRoute,
  path: "/harness-protected",
});
