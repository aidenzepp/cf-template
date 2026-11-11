import { RegistryProvider } from "@effect/atom-react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { run } from "../runtime.ts";
import { readRootContext } from "../session.ts";
import appCss from "../styles/app.css?url";

/**
 * The document shell of every page.
 *
 * @param props - The shell's props.
 * @param props.children - The matched route's page.
 * @returns The `html` element of the page.
 */
const RootDocument = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRoute({
  beforeLoad: ({ abortController }) => run(readRootContext, { signal: abortController.signal }),
  component: () => (
    <RegistryProvider>
      <Outlet />
    </RegistryProvider>
  ),
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "web" },
    ],
  }),
  shellComponent: RootDocument,
});
