import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import type { AnyFormApi } from "@tanstack/react-form";
import { Button } from "@workspace/ui/components/ui/button";
import { Field, FieldError, FieldLabel } from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import { Schema, SchemaIssue } from "effect";
import type { ComponentProps } from "react";

/**
 * The contexts the form's field and form components read: the field or form they sit under.
 */
const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

/**
 * A labelled text input bound to the field it sits under. The field's validation issues show under
 * the input, which takes `aria-invalid` and `aria-describedby` while it has one. The input's `id`
 * is the field's name, so a label and a focus call find it.
 *
 * @param props - The input's props, and the `label` the field shows.
 * @param props.label - The label text.
 * @returns The field.
 */
const TextField = ({
  label,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, "id" | "name" | "onBlur" | "onChange" | "value"> & {
  readonly label: string;
}) => {
  const field = useFieldContext<string>();
  const { errors } = field.state.meta;
  const invalid = errors.length > 0;
  const errorId = `${field.name}-error`;

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        {...inputProps}
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid}
        id={field.name}
        name={field.name}
        onBlur={field.handleBlur}
        onChange={(event) => {
          field.handleChange(event.target.value);
        }}
        value={field.state.value}
      />
      <FieldError errors={errors} id={errorId} />
    </Field>
  );
};

/**
 * A submit button that disables itself while the form submits.
 *
 * @param props - The button's props.
 * @param props.children - The label.
 * @returns The button.
 */
const SubmitButton = ({ children }: { readonly children: string }) => {
  const form = useFormContext();

  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(submitting) => (
        <Button disabled={submitting} type="submit">
          {children}
        </Button>
      )}
    </form.Subscribe>
  );
};

/**
 * Turns a contract schema into the form's `validators.onSubmit`. A check says its own line through
 * the `message` annotation of the check; a field that is missing or the wrong kind asks to be
 * filled in; a check without a line asks for a second look. The parser's own wording never reaches
 * a person.
 *
 * @param schema - The contract schema of the form's fields, named as the inputs' `name`.
 * @returns The schema as a Standard Schema, which TanStack Form maps to its fields.
 */
export const formValidator = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(schema, {
    checkHook: (issue) => SchemaIssue.defaultCheckHook(issue) ?? "Check this field.",
    leafHook: () => "Fill in this field.",
  });

/**
 * An email address as far as a form checks it: something before and after one `@`. The server
 * decides whether it is real.
 */
export const EmailAddress = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+$/u, { message: "Enter an email like ada@example.com." }),
);

/**
 * Moves focus to the first field that failed validation, in the order the fields render. TanStack
 * Form has no focus management of its own.
 *
 * @param props - What `onSubmitInvalid` receives.
 * @param props.formApi - The form that failed to validate.
 */
export const focusFirstInvalid = ({ formApi }: { readonly formApi: AnyFormApi }): void => {
  const first = Object.entries(formApi.state.fieldMeta).find(
    ([, meta]) => (meta?.errors.length ?? 0) > 0,
  );

  if (first !== undefined) {
    document.querySelector<HTMLElement>(`#${first[0]}`)?.focus();
  }
};

/**
 * The one form hook of `web`: `useAppForm` makes a form whose `AppField` renders `TextField` and
 * whose `SubmitButton` reads the form's submit state. Validators come from the contract's schemas
 * through `Schema.toStandardSchemaV1`, as `validators.onSubmit`.
 */
export const { useAppForm } = createFormHook({
  fieldComponents: { TextField },
  fieldContext,
  formComponents: { SubmitButton },
  formContext,
});
