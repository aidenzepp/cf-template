import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/ui/sidebar";
import { isActivePath, navItemsOf } from "./nav-items.ts";

/**
 * The `Link` options of the home link: matched exactly, so it is not current on every page.
 */
const exactOptions = { exact: true } as const;

/**
 * The sidebar's navigation, built from the `nav` static data of the router's routes. A route
 * without the key has no link. Following a link closes the mobile sheet.
 *
 * @returns The navigation group.
 */
export const Nav = () => {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { setOpenMobile } = useSidebar();
  const items = navItemsOf(Object.values<AnyRoute>({ ...router.routesById }));

  const close = () => {
    setOpenMobile(false);
  };

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <nav aria-label="Main">
          <SidebarMenu>
            {items.map((item) => {
              const active = isActivePath(item.to, pathname);

              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    aria-current={active ? "page" : undefined}
                    isActive={active}
                    onClick={close}
                    render={
                      <Link
                        activeOptions={item.to === "/" ? exactOptions : undefined}
                        to={item.to}
                      />
                    }
                  >
                    {item.label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};
