import { Option, Schema } from "effect";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { AuthErrorInput } from "../../lib/auth-error-copy.ts";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";

/**
 * The result an auth client call settles with: `error` is set when the call failed.
 */
interface AuthResult {
  readonly error: AuthErrorInput["error"];
}

/**
 * Submit state of an auth form: the line to show, whether a call is in flight, and `submit`, which
 * runs a client call and navigates to `redirect` when it succeeds.
 *
 * A call that rejects before any response is shown as status 0. A call still in flight when the
 * route unmounts is aborted and shows nothing.
 *
 * @param redirect - The validated root-relative path to open after success.
 * @returns The form's submit state.
 */
export const useAuthSubmit = (redirect: string) => {
  const router = useRouter();
  const controller = useRef<AbortController | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const submit = (call: (signal: AbortSignal) => PromiseLike<AuthResult>) => {
    controller.current?.abort();
    const next = new AbortController();

    controller.current = next;
    setMessage(null);
    setPending(true);

    const settle = ({ error }: AuthResult) => {
      if (next.signal.aborted) {
        return;
      }

      setPending(false);

      if (error === null) {
        router.history.push(redirect);

        return;
      }

      setMessage(authErrorCopy({ aborted: false, error }));
    };

    void Promise.resolve(call(next.signal))
      .catch((): AuthResult => ({ error: { status: 0 } }))
      .then(settle);
  };

  return { message, pending, submit };
};

const decodeText = Schema.decodeUnknownOption(Schema.String);

/**
 * Read a text field of a submitted form.
 *
 * @param form - The submitted form's data.
 * @param name - The field's name.
 * @returns The field's text, or an empty string for a missing or file field.
 */
export const readField = (form: FormData, name: string): string => {
  const value = form.get(name);

  return Option.getOrElse(decodeText(value), () => "");
};
