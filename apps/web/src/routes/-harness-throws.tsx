import { createFileRoute, notFound } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { run } from "../runtime.ts";

declare module "@tanstack/react-router" {
  // The production route tree ignores this file, so its generated types do not know the path.
  interface FileRoutesByPath {
    "/-harness-throws": {
      fullPath: "/-harness-throws";
      id: "/-harness-throws";
      parentRoute: AnyRoute;
      path: "/-harness-throws";
      preLoaderRoute: AnyRoute;
    };
  }
}

/**
 * The fixture the error-route harness requests. The `-` prefix keeps it out of the production route
 * tree; a build with `WEB_HARNESS_ROUTES=1` registers it. Its loader reports its record missing
 * for `?kind=not-found` and dies with an undeclared defect for anything else; the harness asserts
 * that no page shows the defect's text.
 */
export const Route = createFileRoute("/-harness-throws")({
  loaderDeps: ({ search }: { readonly search: { readonly kind?: string } }) => ({
    kind: search.kind ?? "defect",
  }),
  loader: ({ deps }) =>
    run(deps.kind === "not-found" ? Effect.fail(notFound()) : Effect.die("harness-defect-secret")),
});
