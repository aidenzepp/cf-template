import { createFileRoute, useRouteContext, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/ui/alert";
import { Button } from "@workspace/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/ui/card";
import { Checkbox } from "@workspace/ui/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect } from "effect";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { Reauthenticate } from "../components/auth/reauthenticate.tsx";
import { readField } from "../components/auth/use-auth-submit.ts";
import { authClient } from "../lib/auth-client.ts";
import { authErrorCopy } from "../lib/auth-error-copy.ts";
import { oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";
import { needsFreshSession, settingsCalls, settle } from "../lib/settings-calls.ts";
import type { Settled } from "../lib/settings-calls.ts";
import { run as runEffect } from "../runtime.ts";

const calls = settingsCalls(authClient);

/**
 * The outcome line of one card.
 */
interface Outcome {
  readonly failed: boolean;
  readonly text: string | null;
}

const NO_OUTCOME: Outcome = { failed: false, text: null };

/**
 * Runs a card's calls and keeps its outcome line. A call the server refuses for a stale session
 * asks for the password, then runs again.
 *
 * @param askFresh - Opens the prompt and keeps the call to retry.
 * @returns The outcome line, whether a call is in flight, and `run`.
 */
const useRun = (askFresh: (retry: () => void) => void) => {
  const [outcome, setOutcome] = useState<Outcome>(NO_OUTCOME);
  const [pending, setPending] = useState(false);

  const run = (call: () => PromiseLike<Settled>, done: string, after?: () => void) => {
    const attempt = () => {
      setOutcome(NO_OUTCOME);
      setPending(true);
      void runEffect(
        settle(call).pipe(
          Effect.tap(({ error }) =>
            Effect.sync(() => {
              setPending(false);

              if (needsFreshSession(error)) {
                askFresh(attempt);

                return;
              }

              setOutcome({
                failed: error !== null,
                text: error === null ? done : authErrorCopy({ aborted: false, error }),
              });
              after?.();
            }),
          ),
        ),
      );
    };

    attempt();
  };

  return { outcome, pending, run };
};

/**
 * The line under a card's form.
 *
 * @param props - The line's props.
 * @param props.outcome - The card's outcome.
 * @returns The line, or nothing.
 */
const OutcomeLine = ({ outcome }: { readonly outcome: Outcome }) =>
  outcome.failed ? (
    <FieldError>{outcome.text}</FieldError>
  ) : (
    <FieldDescription>{outcome.text}</FieldDescription>
  );

const ProfileCard = ({
  askFresh,
  image,
  name,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly image: string | null;
  readonly name: string;
}) => {
  const { outcome, pending, run } = useRun(askFresh);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    run(() => calls.updateProfile(readField(form, "name"), readField(form, "image")), "Saved.");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input defaultValue={name} id="profile-name" name="name" required type="text" />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-image">Image URL</FieldLabel>
              <Input defaultValue={image ?? ""} id="profile-image" name="image" type="url" />
            </Field>
            <OutcomeLine outcome={outcome} />
            <Button disabled={pending} type="submit">
              Save profile
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

const PasswordCard = ({ askFresh }: { readonly askFresh: (retry: () => void) => void }) => {
  const { outcome, pending, run } = useRun(askFresh);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const current = readField(form, "current");
    const next = readField(form, "next");
    const revoke = form.get("revoke") !== null;

    run(() => calls.changePassword(current, next, revoke), "Password changed.");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password-current">Current password</FieldLabel>
              <Input
                autoComplete="current-password"
                id="password-current"
                name="current"
                required
                type="password"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-next">New password</FieldLabel>
              <Input
                autoComplete="new-password"
                id="password-next"
                name="next"
                required
                type="password"
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox defaultChecked id="password-revoke" name="revoke" />
              <FieldLabel htmlFor="password-revoke">Sign out other devices</FieldLabel>
            </Field>
            <OutcomeLine outcome={outcome} />
            <Button disabled={pending} type="submit">
              Change password
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
};

/**
 * The account settings screen. The root guard keeps a signed-out caller out; a stale session is
 * answered by the server, and the prompt asks for the password again.
 *
 * @returns The page body.
 */
const Settings = () => {
  const { session } = useRouteContext({ from: "/settings" });
  const { error } = useSearch({ from: "/settings" });
  const [retry, setRetry] = useState<(() => void) | undefined>(undefined);

  if (session._tag !== "signedIn") {
    return null;
  }

  const askFresh = (next: () => void) => {
    setRetry(() => next);
  };

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{oauthErrorCopy(error)}</AlertDescription>
        </Alert>
      )}
      <ProfileCard askFresh={askFresh} image={session.session.image} name={session.session.name} />
      <PasswordCard askFresh={askFresh} />
      <Reauthenticate
        email={session.session.email}
        onCancel={() => {
          setRetry(undefined);
        }}
        onDone={() => {
          retry?.();
          setRetry(undefined);
        }}
        open={retry !== undefined}
      />
    </main>
  );
};

export const Route = createFileRoute("/settings")({
  component: Settings,
  // The same allowlist as `/oauth-error`: only a known code reaches the page or the address bar.
  search: { middlewares: [({ search }) => ({ error: search.error })] },
  validateSearch: (search: { readonly error?: unknown }) => ({
    error: oauthErrorCode(search.error),
  }),
});
