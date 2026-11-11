import { createFileRoute, useRouteContext } from "@tanstack/react-router";

/**
 * The home page: it marks the root route's session state until the shell lands.
 *
 * @returns The page body.
 */
const Home = () => {
  const { session } = useRouteContext({ from: "/" });

  return <main data-session={session._tag}>web</main>;
};

export const Route = createFileRoute("/")({ component: Home });
