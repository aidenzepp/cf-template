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
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { readField } from "./use-auth-submit.ts";

/**
 * The code Better Auth answers with when a sensitive action needs a fresher session. The server
 * decides this; the client never measures the session's age.
 */
export const FRESH_SESSION_CODE = "SESSION_NOT_FRESH";

/**
 * The prompt that asks for the password again, opened when the server refuses an action for a stale
 * session. A correct password signs in again, which makes the session fresh, then `onDone` retries
 * the refused action. The password is read from the submitted form and never kept.
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

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const password = readField(new FormData(event.currentTarget), "password");

    setMessage(null);
    void Promise.resolve(authClient.signIn.email({ email, password }))
      .catch(() => ({ error: { status: 0 } }))
      .then(({ error }) => {
        if (error === null) {
          onDone();
        } else {
          setMessage(authErrorCopy({ aborted: false, error }));
        }

        return null;
      });
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
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>Enter your password to continue.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
};
