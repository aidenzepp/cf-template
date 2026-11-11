import { createFileRoute, redirect } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

/**
 * The home page.
 *
 * @returns The page body.
 */
const Home = () => <main>web</main>;

export const Route = createFileRoute("/")({
  // Only `signedOut` redirects; `unknown` renders the shell. `location.href` is root-relative.
  // The redirect is not checked against the route tree: `/sign-in` redirects to `/`, so checking
  // both directions would make the route types circular.
  beforeLoad: ({ context, location }) =>
    context.session._tag === "signedOut"
      ? redirect<AnyRouter>({ search: { redirect: location.href }, to: "/sign-in" })
      : {},
  component: Home,
  staticData: { nav: { label: "Home", order: 0 } },
});
