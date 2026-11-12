import { Option, Schema } from "effect";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    readonly nav?: { readonly label: string; readonly order: number };
  }
}

/**
 * The part of a router route the sidebar reads: its full path and the `nav` entry of its static
 * data. A `routesById` value satisfies it.
 */
export interface NavRoute {
  readonly fullPath: string;
  readonly options: {
    readonly staticData?: { readonly nav?: { readonly label: string; readonly order: number } };
  };
}

/**
 * One sidebar link: its text, its position and the path it opens.
 */
export interface NavItem {
  readonly label: string;
  readonly order: number;
  readonly to: string;
}

const decodePath = Schema.decodeUnknownOption(Schema.String);

/**
 * Builds the sidebar's links from the routes that declare `staticData.nav`, sorted by `order`. A
 * route adds itself to the sidebar by declaring the key; there is no central list.
 *
 * @param routes - The routes of the router.
 * @returns The links, lowest `order` first.
 */
export const navItemsOf = (routes: ReadonlyArray<NavRoute>): ReadonlyArray<NavItem> =>
  routes
    .flatMap((route) => {
      const nav = route.options.staticData?.nav;
      const to = decodePath(route.fullPath);

      return nav === undefined || Option.isNone(to)
        ? []
        : [{ label: nav.label, order: nav.order, to: to.value }];
    })
    .toSorted((a, b) => a.order - b.order);

/**
 * Whether a link is the current page or an ancestor of it. `/` is current only on `/` itself; any
 * other link is current on its own path and below it, so `/widgets` stays marked on `/widgets/1`.
 *
 * @param to - The path a link opens.
 * @param pathname - The pathname of the current location.
 * @returns `true` when the link should be marked as the current page.
 */
export const isActivePath = (to: string, pathname: string): boolean =>
  to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
