import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { ReactNode } from "react";

/**
 * The card around an auth form, with the link to the other screen.
 *
 * @param props - The shell's props.
 * @param props.title - The card's heading.
 * @param props.description - The line under the heading.
 * @param props.children - The form.
 * @param props.otherTo - The other auth screen.
 * @param props.otherLabel - The link text to the other screen.
 * @param props.redirect - The validated `redirect`, when supplied, to carry to the other screen.
 * @returns The page body.
 */
export const AuthFormShell = ({
  children,
  description,
  otherLabel,
  otherTo,
  redirect,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly otherLabel: string;
  readonly otherTo: "/sign-in" | "/sign-up";
  readonly redirect: string | undefined;
  readonly title: string;
}) => {
  const search = useMemo(() => ({ redirect }), [redirect]);

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">{children}</div>
        </CardContent>
      </Card>
      <Link className="text-center text-sm underline" search={search} to={otherTo}>
        {otherLabel}
      </Link>
    </main>
  );
};
