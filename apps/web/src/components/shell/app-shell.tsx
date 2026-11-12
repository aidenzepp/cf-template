import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/ui/sidebar";
import type { ReactNode } from "react";
import { Nav } from "./nav.tsx";
import { UserMenu } from "./user-menu.tsx";

/**
 * The sidebar: the product name, the navigation built from route `staticData.nav` and the account
 * menu. At phone width the vendored sidebar renders it as a sheet that the trigger opens.
 *
 * @returns The sidebar.
 */
const AppSidebar = () => (
  <Sidebar>
    <SidebarHeader>
      <span className="px-2 py-1 text-sm font-semibold">web</span>
    </SidebarHeader>
    <SidebarContent>
      <Nav />
    </SidebarContent>
    <SidebarFooter>
      <UserMenu />
    </SidebarFooter>
  </Sidebar>
);

/**
 * The signed-in layout: the sidebar beside a top bar with the sidebar trigger and the page. The
 * page brings its own `main`, so the content column is a `div`, not the vendored `SidebarInset`,
 * whose `main` element would nest inside it.
 *
 * @param props - The shell's props.
 * @param props.children - The matched route's page.
 * @returns The shell around the page.
 */
export const AppShell = ({ children }: { readonly children: ReactNode }) => (
  <SidebarProvider>
    <a
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      href="#content"
    >
      Skip to content
    </a>
    <AppSidebar />
    <div
      className="flex min-w-0 flex-1 flex-col bg-background outline-none"
      id="content"
      tabIndex={-1}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
      </header>
      {children}
    </div>
  </SidebarProvider>
);
