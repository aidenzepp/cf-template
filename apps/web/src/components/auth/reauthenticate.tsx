import { Button } from "@workspace/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { decodeAccounts, providerName, reauthProviders, settle } from "../../lib/settings-calls.ts";
import type { Settled } from "../../lib/settings-calls.ts";
import { run } from "../../runtime.ts";
import { readField } from "./use-auth-submit.ts";

/**
 * The prompt that asks for a fresh sign-in, opened when the server refuses an action for a stale
 * session. An account with a password answers with it; an account without one signs in again with
 * a linked provider. Either makes the session fresh, then `onDone` retries the refused action. The
 * password is read from the submitted form and never kept.
 *
 * @param props - The prompt's props.
 * @param props.email - The email of the signed-in account.
 * @param props.open - Whether the prompt shows.
 * @param props.onDone - Called after the session is fresh again.
 * @param props.onCancel - Called when the prompt is dismissed.
 * @returns The dialog.
 */
export const Reauthenticate = ({
  email,
  onCancel,
  onDone,
  open,
}: {
  readonly email: string;
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly string[]>([]);

  useEffect(() => {
    if (open) {
      void run(
        settle(() => authClient.listAccounts()).pipe(
          Effect.tap(({ data }) =>
            Effect.sync(() => {
              setProviders(reauthProviders(decodeAccounts(data)));
            }),
          ),
        ),
      );
    }
  }, [open]);

  const answer = (call: () => PromiseLike<Settled>, succeeded: () => void) => {
    setMessage(null);
    void run(
      settle(call).pipe(
        Effect.tap(({ error }) =>
          Effect.sync(() => {
            if (error === null) {
              succeeded();
            } else {
              setMessage(authErrorCopy({ aborted: false, error }));
            }
          }),
        ),
      ),
    );
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const password = readField(new FormData(event.currentTarget), "password");

    answer(() => authClient.signIn.email({ email, password }), onDone);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            {providers.length === 0
              ? "Enter your password to continue."
              : "You have no password. Sign in again to continue."}
          </DialogDescription>
        </DialogHeader>
        {providers.length === 0 ? (
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reauth-password">Password</FieldLabel>
                <Input
                  autoComplete="current-password"
                  id="reauth-password"
                  name="password"
                  required
                  type="password"
                />
              </Field>
              <FieldError>{message}</FieldError>
              <Button type="submit">Continue</Button>
            </FieldGroup>
          </form>
        ) : (
          <FieldGroup>
            {providers.map((provider) => (
              <Button
                key={provider}
                onClick={() => {
                  answer(
                    () => authClient.signIn.social({ callbackURL: "/settings", provider }),
                    onDone,
                  );
                }}
                type="button"
              >
                {`Sign in again with ${providerName(provider)}`}
              </Button>
            ))}
            <FieldError>{message}</FieldError>
          </FieldGroup>
        )}
      </DialogContent>
    </Dialog>
  );
};
