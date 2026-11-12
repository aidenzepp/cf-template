import { createFileRoute, useRouteContext, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/ui/alert";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Checkbox } from "@workspace/ui/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Effect, Option } from "effect";
import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { Reauthenticate } from "../components/auth/reauthenticate.tsx";
import { readField } from "../components/auth/use-auth-submit.ts";
import { authClient } from "../lib/auth-client.ts";
import { authErrorCopy } from "../lib/auth-error-copy.ts";
import { oauthErrorCode, oauthErrorCopy } from "../lib/oauth-error-copy.ts";
import {
  PASSKEY_FALLBACK_NAME,
  decodeAccounts,
  decodePasskeys,
  needsFreshSession,
  passkeyHint,
  providerName,
  settingsCalls,
  settle,
} from "../lib/settings-calls.ts";
import type { Settled } from "../lib/better-auth-call.ts";
import { run as runEffect } from "../runtime.ts";

const calls = settingsCalls(authClient);

const passkeysOf = ({ data }: Settled) => decodePasskeys(data);

const accountsOf = ({ data }: Settled) => decodeAccounts(data);

/**
 * The outcome line of one card.
 */
interface Outcome {
  readonly failed: boolean;
  readonly text: string | null;
}

const NO_OUTCOME: Outcome = { failed: false, text: null };

/**
 * Loads a list when the card mounts and again after `reload`. A failed load leaves the list empty
 * and keeps the error line to show.
 *
 * @param call - Reads the list.
 * @param decode - Decodes the list from the call's data.
 * @returns The list, the error line of a failed load, and `reload`.
 */
const useLoaded = <Item,>(
  call: () => PromiseLike<Settled>,
  decode: (settled: Settled) => Option.Option<ReadonlyArray<Item>>,
) => {
  const [items, setItems] = useState<ReadonlyArray<Item>>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;

    void runEffect(
      settle(call).pipe(
        Effect.tap((settled) =>
          Effect.sync(() => {
            if (!current) {
              return;
            }

            const { error } = settled;
            const list = decode(settled);

            setItems(Option.getOrElse(list, () => []));
            setFailure(
              authErrorCopy({
                aborted: false,
                error: error ?? (Option.isNone(list) ? { status: 500 } : null),
              }),
            );
          }),
        ),
      ),
    );

    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reloads is the Reload trigger: bumping it reruns the effect; the effect intentionally does not read it
  }, [call, decode, reloads]);

  return {
    failure,
    items,
    reload: () => {
      setReloads((count) => count + 1);
    },
  };
};

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

const PasskeysCard = ({
  askFresh,
  emailLive,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly emailLive: boolean;
}) => {
  const { outcome, pending, run } = useRun(askFresh);
  const { failure, items: passkeys, reload } = useLoaded(calls.listPasskeys, passkeysOf);
  const hint = passkeyHint(emailLive);

  const onAdd = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = readField(new FormData(event.currentTarget), "name");

    run(() => calls.addPasskey(name), "Passkey added.", reload);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        {hint === null ? null : <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {passkeys.map((passkey) => (
            <form
              key={passkey.id}
              onSubmit={(event) => {
                event.preventDefault();

                const name = readField(new FormData(event.currentTarget), "name");

                run(() => calls.renamePasskey(passkey.id, name), "Passkey renamed.", reload);
              }}
            >
              <Field orientation="horizontal">
                <Input
                  aria-label="Passkey name"
                  defaultValue={passkey.name ?? PASSKEY_FALLBACK_NAME}
                  name="name"
                  required
                  type="text"
                />
                <Button disabled={pending} type="submit" variant="outline">
                  Rename
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => {
                    run(() => calls.deletePasskey(passkey.id), "Passkey deleted.", reload);
                  }}
                  type="button"
                  variant="outline"
                >
                  Delete
                </Button>
              </Field>
            </form>
          ))}
          <form onSubmit={onAdd}>
            <Field orientation="horizontal">
              <Input aria-label="New passkey name" name="name" placeholder="Name" type="text" />
              <Button disabled={pending} type="submit">
                Add passkey
              </Button>
            </Field>
          </form>
          <FieldError>{failure}</FieldError>
          <OutcomeLine outcome={outcome} />
        </FieldGroup>
      </CardContent>
    </Card>
  );
};

const AccountsCard = ({
  askFresh,
  providers,
}: {
  readonly askFresh: (retry: () => void) => void;
  readonly providers: ReadonlyArray<string>;
}) => {
  const { outcome, pending, run } = useRun(askFresh);
  const { failure, items: accounts, reload } = useLoaded(calls.listAccounts, accountsOf);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected accounts</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {providers.map((provider) => {
            const name = providerName(provider);
            const account = accounts.find(({ providerId }) => providerId === provider);

            return account === undefined ? (
              <Button
                disabled={pending}
                key={provider}
                onClick={() => {
                  run(() => calls.linkProvider(provider), "");
                }}
                type="button"
                variant="outline"
              >
                {`Link ${name}`}
              </Button>
            ) : (
              <Button
                disabled={pending}
                key={provider}
                onClick={() => {
                  run(() => calls.unlinkAccount(account.id), `${name} unlinked.`, reload);
                }}
                type="button"
                variant="outline"
              >
                {`Unlink ${name}`}
              </Button>
            );
          })}
          <FieldError>{failure}</FieldError>
          <OutcomeLine outcome={outcome} />
        </FieldGroup>
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
  const { authMethods, session } = useRouteContext({ from: "/settings" });
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
      <PasskeysCard askFresh={askFresh} emailLive={authMethods.email} />
      <AccountsCard askFresh={askFresh} providers={authMethods.providers} />
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
  staticData: { nav: { label: "Settings", order: 20 } },
  validateSearch: (search: { readonly error?: unknown }) => ({
    error: oauthErrorCode(search.error),
  }),
});
