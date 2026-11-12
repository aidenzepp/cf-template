import { createFileRoute, redirect, useRouteContext } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

/**
 * The dashboard a signed-in person lands on, greeting them by the name in the session.
 *
 * @returns The page body.
 */
const Dashboard = () => {
  const { session } = useRouteContext({ from: "/" });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-4">
      <h1 className="text-lg font-semibold">Dashboard</h1>
      <p className="text-muted-foreground">
        {session._tag === "signedIn" ? `Welcome back, ${session.session.name}.` : "Welcome back."}
      </p>
    </main>
  );
};

export const Route = createFileRoute("/")({
  // Only `signedOut` redirects; `unknown` renders the shell. `location.href` is root-relative.
  // The redirect is not checked against the route tree: `/sign-in` redirects to `/`, so checking
  // both directions would make the route types circular.
  beforeLoad: ({ context, location }) =>
    context.session._tag === "signedOut"
      ? redirect<AnyRouter>({ search: { redirect: location.href }, to: "/sign-in" })
      : {},
  component: Dashboard,
  staticData: { nav: { label: "Dashboard", order: 0 } },
});
