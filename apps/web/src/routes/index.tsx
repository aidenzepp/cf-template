import { createFileRoute } from "@tanstack/react-router";
import { Placeholder } from "../components/placeholder.tsx";
import { run, stackNameText } from "../runtime.ts";
import { readStackName } from "../web-layer.ts";

export const Route = createFileRoute("/")({
  component: Placeholder,
  loader: ({ abortController }) =>
    run(readStackName({ STACK_NAME: stackNameText() }), { signal: abortController.signal }),
  // The document title follows the heading: the stack name, over the root's fallback.
  head: ({ loaderData }) => ({ meta: loaderData === undefined ? [] : [{ title: loaderData }] }),
});
