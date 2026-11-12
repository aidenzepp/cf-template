import { useRouteContext, useRouter } from "@tanstack/react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@workspace/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@workspace/ui/components/ui/sidebar";
import { toast } from "sonner";
import { authClient } from "../../lib/auth-client.ts";
import { fork } from "../../runtime.ts";
import { signOutFailure, signOutFlow } from "./sign-out.ts";

/**
 * The account row of the sidebar footer and its menu, with Sign out. The menu opens beside the
 * sidebar on desktop and above the row inside the mobile sheet.
 *
 * @param props - The menu's props.
 * @param props.user - The profile fields of the browser's session.
 * @param props.user.email - The account's email.
 * @param props.user.image - The avatar URL, if any.
 * @param props.user.name - The display name.
 * @returns The menu.
 */
const AccountMenu = ({
  user,
}: {
  readonly user: {
    readonly email: string;
    readonly image?: string | null | undefined;
    readonly name: string;
  };
}) => {
  const router = useRouter();
  const { isMobile } = useSidebar();

  // The root `beforeLoad` re-derives the state after `invalidate`. A failed sign-out leaves the
  // session in place, so the person stays here and sees why.
  const signOut = () => {
    fork(
      signOutFlow({
        call: () => authClient.signOut(),
        fail: () => {
          toast.error(signOutFailure.title, { description: signOutFailure.description });
        },
        leave: async () => {
          await router.invalidate();
          await router.navigate({ search: { redirect: undefined }, to: "/sign-in" });
        },
      }),
    );
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton aria-label="Account menu" size="lg" />}>
            <Avatar>
              {user.image === null || user.image === undefined ? null : (
                <AvatarImage alt="" src={user.image} />
              )}
              <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={isMobile ? "center" : "end"}
            className="min-w-56"
            side={isMobile ? "top" : "right"}
          >
            <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

/**
 * The sidebar footer's account control. The shell only renders for a signed-in route context;
 * `useSession` supplies profile fields only, so the skeleton paints until the browser's session
 * has data, and never a sign-in link.
 *
 * @returns The control for the current state.
 */
export const UserMenu = () => {
  const { session } = useRouteContext({ from: "__root__" });
  const { data } = authClient.useSession();

  if (session._tag !== "signedIn") {
    return null;
  }

  return data === null ? (
    <output aria-label="Loading account" className="block">
      <SidebarMenuSkeleton showIcon />
    </output>
  ) : (
    <AccountMenu user={data.user} />
  );
};
