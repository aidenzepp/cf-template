import { getRouteApi } from "@tanstack/react-router";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";

const indexRoute = getRouteApi("/");

/**
 * The placeholder page `web` serves until the next UI is built. Its title is the stack name
 * `infra` binds, so a project made from the template shows its own name. It reads the loader of
 * the `/` route through `getRouteApi`, so the route file need not export it.
 *
 * @returns The page body.
 */
export const Placeholder = () => {
  const stackName = indexRoute.useLoaderData();

  return (
    <main className="flex min-h-svh">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{stackName}</EmptyTitle>
          <EmptyDescription>The next UI is built here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
};
