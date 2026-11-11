import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@workspace/ui/components/ui/avatar";
import { buttonVariants } from "@workspace/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/ui/dropdown-menu";
import { Skeleton } from "@workspace/ui/components/ui/skeleton";
import { authClient } from "../../lib/auth-client.ts";

/**
 * The avatar button and its menu, with Sign out.
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

  // The root `beforeLoad` re-derives the state after `invalidate`; a failed sign-out leaves the
  // session in place, so the sign-in screen sends the person back to `/`.
  const signOut = () => {
    void authClient
      .signOut()
      .catch(() => null)
      .then(() => router.invalidate())
      .then(() => router.navigate({ search: { redirect: undefined }, to: "/sign-in" }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Account menu">
        <Avatar>
          {user.image === null || user.image === undefined ? null : (
            <AvatarImage alt="" src={user.image} />
          )}
          <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate">{user.name}</span>
            <span className="block truncate text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * The shell's account control. Signed-in state comes from the route context; `useSession` supplies
 * profile fields only. A signed-in or unknown state paints the skeleton until the browser's
 * session has data, and never "Sign in".
 *
 * @returns The control for the current state.
 */
export const UserMenu = () => {
  const { session } = useRouteContext({ from: "__root__" });
  const { data } = authClient.useSession();

  if (session._tag === "signedOut") {
    return (
      <Link
        className={buttonVariants({ variant: "outline" })}
        search={{ redirect: undefined }}
        to="/sign-in"
      >
        Sign in
      </Link>
    );
  }

  return data === null ? (
    <output aria-label="Loading account" className="block">
      <Skeleton className="size-8" />
    </output>
  ) : (
    <AccountMenu user={data.user} />
  );
};
