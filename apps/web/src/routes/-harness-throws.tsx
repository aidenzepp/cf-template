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
 * for `?kind=not-found`, fails with a bare string for `?kind=string` or a plain object for
 * `?kind=object` (`run` rejects with a typed failure as it is), and dies with an undeclared defect
 * for anything else; the harness asserts that no page shows the thrown text. The router generator
 * reads this export by name; no module imports it.
 *
 * @public
 */
export const Route = createFileRoute("/-harness-throws")({
  loaderDeps: ({ search }: { readonly search: { readonly kind?: string } }) => ({
    kind: search.kind ?? "defect",
  }),
  loader: ({ deps }) => {
    if (deps.kind === "string") {
      return run(Effect.fail("harness-string-secret"));
    }

    if (deps.kind === "object") {
      return run(Effect.fail({ apiKey: "harness-object-secret" }));
    }

    return run(
      deps.kind === "not-found" ? Effect.fail(notFound()) : Effect.die("harness-defect-secret"),
    );
  },
});
