import { createFileRoute } from "@tanstack/react-router";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/ui/empty";
import { run, stackNameText } from "../runtime.ts";
import { readStackName } from "../web-layer.ts";

/**
 * The placeholder page `web` serves until the next UI is built. Its title is the stack name
 * `infra` binds, so a project made from the template shows its own name.
 *
 * @returns The page body.
 */
const Placeholder = () => {
  const stackName = Route.useLoaderData();

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

export const Route = createFileRoute("/")({
  component: Placeholder,
  loader: ({ abortController }) =>
    run(readStackName({ STACK_NAME: stackNameText() }), { signal: abortController.signal }),
});
