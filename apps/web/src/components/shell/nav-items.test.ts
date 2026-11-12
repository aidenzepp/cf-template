import { describe, expect, it } from "@effect/vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { isActivePath, navItemsOf } from "./nav-items.ts";

/**
 * A router over a root and the given routes, each with the static data it declares.
 */
const routerOf = (
  entries: ReadonlyArray<{
    readonly path: string;
    readonly staticData: { readonly nav?: { readonly label: string; readonly order: number } };
  }>,
) => {
  const root = createRootRoute();

  const children = entries.map(({ path, staticData }) =>
    createRoute({ getParentRoute: () => root, path, staticData }),
  );

  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren(children),
  });
};

describe("navItemsOf", () => {
  it("lists a route that declares staticData.nav, sorted by order, and no other", () => {
    const router = routerOf([
      { path: "/settings", staticData: { nav: { label: "Settings", order: 20 } } },
      { path: "/sign-in", staticData: {} },
      { path: "/", staticData: { nav: { label: "Dashboard", order: 0 } } },
      { path: "/reports", staticData: { nav: { label: "Reports", order: 15 } } },
    ]);

    expect(navItemsOf(Object.values(router.routesById))).toStrictEqual([
      { label: "Dashboard", order: 0, to: "/" },
      { label: "Reports", order: 15, to: "/reports" },
      { label: "Settings", order: 20, to: "/settings" },
    ]);
  });

  it("is empty when no route declares nav", () => {
    const router = routerOf([{ path: "/sign-in", staticData: {} }]);

    expect(navItemsOf(Object.values(router.routesById))).toStrictEqual([]);
  });
});

describe("isActivePath", () => {
  it("marks / only on /", () => {
    expect(isActivePath("/", "/")).toBeTruthy();
    expect(isActivePath("/", "/notes")).toBeFalsy();
  });

  it("marks a link on its path and below it, never on a path that only shares the prefix", () => {
    expect(isActivePath("/notes", "/notes")).toBeTruthy();
    expect(isActivePath("/notes", "/notes/abc")).toBeTruthy();
    expect(isActivePath("/notes", "/notesy")).toBeFalsy();
    expect(isActivePath("/notes", "/")).toBeFalsy();
  });
});
