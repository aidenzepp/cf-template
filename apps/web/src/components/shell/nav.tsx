import { Link, useRouter } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import type { AnyRoute } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    readonly nav?: { readonly label: string; readonly order: number };
  }
}

const decodePath = Schema.decodeUnknownOption(Schema.String);

/**
 * The shell's navigation, built from the `nav` static data of the router's routes and sorted by
 * `order`. A route without the key has no link.
 *
 * @returns The navigation bar.
 */
export const Nav = () => {
  const router = useRouter();

  const items = Object.values<AnyRoute>({ ...router.routesById })
    .flatMap((route) => {
      const nav = route.options.staticData?.nav;
      const to = decodePath(route.fullPath);

      return nav === undefined || Option.isNone(to)
        ? []
        : [{ label: nav.label, order: nav.order, to: to.value }];
    })
    .toSorted((a, b) => a.order - b.order);

  return (
    <nav aria-label="Main" className="flex items-center gap-4 text-sm">
      {items.map((item) => (
        <Link activeProps={{ "aria-current": "page" }} key={item.to} to={item.to}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
};
