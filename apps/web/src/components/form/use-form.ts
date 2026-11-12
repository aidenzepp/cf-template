import { Effect } from "effect";
import { useEffect, useId, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import type { fork as Fork } from "../../runtime.ts";
import { notify } from "../notify.ts";
import type { FieldErrors, FormSchema } from "./decode-form.ts";
import { submitForm } from "./submit-form.ts";
import type { Invalid, Outcome } from "./submit-form.ts";

/**
 * What a form shows: the message of each invalid field, the line of a failed call, and whether a
 * call is in flight.
 */
interface FormState {
  readonly errors: FieldErrors;
  readonly failure: string | null;
  readonly pending: boolean;
}

const IDLE: FormState = { errors: {}, failure: null, pending: false };

const PENDING: FormState = { ...IDLE, pending: true };

/**
 * The options of a form.
 */
export interface FormOptions {
  /**
   * The web runtime's `fork`, injected so this module never loads the runtime.
   */
  readonly fork: typeof Fork;
  /**
   * Receives the retry when a call settles as `paused`.
   */
  readonly onPaused?: (retry: () => void) => void;
  /**
   * Clears the fields after a call is saved.
   */
  readonly resetOnSaved?: boolean;
}

/**
 * Runs one call at a time and keeps what the form shows. A call still in flight when the form
 * unmounts is interrupted and shows nothing. A form that fails to decode shows each field's
 * message and moves focus to the first invalid field; a saved call raises its success toast.
 *
 * @param options - The runtime and how a settled call is handled.
 * @returns The state, the form element's ref, and `start`, which runs one attempt.
 */
const useSubmission = ({ fork, onPaused, resetOnSaved = false }: FormOptions) => {
  const form = useRef<HTMLFormElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState(IDLE);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state.errors]);

  const start = (attempt: Effect.Effect<Outcome | Invalid>) => {
    controller.current?.abort();
    const next = new AbortController();

    controller.current = next;
    setState(PENDING);

    const show = (settled: Outcome | Invalid) => {
      if (next.signal.aborted) {
        return;
      }

      setState(
        settled._tag === "Invalid"
          ? { ...IDLE, errors: settled.errors }
          : { ...IDLE, failure: settled._tag === "Failed" ? settled.message : null },
      );

      if (settled._tag === "Paused") {
        onPaused?.(() => {
          start(attempt);
        });
      } else if (settled._tag === "Saved") {
        if (resetOnSaved) {
          form.current?.reset();
        }

        if (settled.title !== undefined) {
          notify.success(settled.title);
        }
      }
    };

    fork(
      attempt.pipe(
        Effect.tap((settled) =>
          Effect.sync(() => {
            show(settled);
          }),
        ),
        Effect.asVoid,
      ),
      {
        signal: next.signal,
      },
    );
  };

  return { form, start, state };
};

/**
 * The one form pattern. The submitted `FormData` is decoded with `schema`; each invalid field
 * shows its message, takes `aria-invalid` and `aria-describedby`, and the first one takes focus.
 * A valid form runs `submit`, whose outcome is a success toast or the failure line.
 *
 * Browser validation is off (`noValidate`) so the schema is the one place a rule lives.
 *
 * @param schema - The schema of the form's fields, named as the inputs' `name`.
 * @param submit - The call made with the decoded value.
 * @param options - The runtime and how a settled call is handled.
 * @returns `formProps` for the `<form>`, `field` for each input, `error` for each field's message,
 *   the form's `failure` line and `pending` flag.
 */
export const useForm = <S extends FormSchema>(
  schema: S,
  submit: (values: S["Type"]) => Effect.Effect<Outcome>,
  options: FormOptions,
) => {
  const { form, start, state } = useSubmission(options);
  const prefix = useId();
  const errorId = (name: string) => `${prefix}-${name}-error`;

  return {
    /**
     * The message of a field: spread it on that field's `<FieldError>`.
     */
    error: (name: string) => ({ children: state.errors[name], id: errorId(name) }),
    /**
     * The attributes of an input that link it to its message.
     */
    field: (name: string) =>
      state.errors[name] === undefined
        ? {}
        : { "aria-describedby": errorId(name), "aria-invalid": true },
    failure: state.failure,
    formProps: {
      noValidate: true,
      onSubmit: (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        start(submitForm(schema, submit)(new FormData(event.currentTarget)));
      },
      ref: form,
    },
    pending: state.pending,
  };
};

/**
 * The same pending state and outcome handling for a call a button makes, which has no fields.
 *
 * @param options - The runtime and how a settled call is handled.
 * @returns The `failure` line, the `pending` flag, and `run`, which makes one call.
 */
export const useAction = (options: FormOptions) => {
  const { start, state } = useSubmission(options);

  return { failure: state.failure, pending: state.pending, run: start };
};
