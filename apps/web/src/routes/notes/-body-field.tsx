import { Field, FieldError, FieldLabel } from "@workspace/ui/components/ui/field";
import { Textarea } from "@workspace/ui/components/ui/textarea";
import type { ComponentProps } from "react";

/**
 * The part of a TanStack Form field the body input reads and writes.
 */
interface BodyFieldApi {
  readonly handleBlur: () => void;
  readonly handleChange: (value: string) => void;
  readonly name: string;
  readonly state: {
    readonly meta: { readonly errors: ComponentProps<typeof FieldError>["errors"] };
    readonly value: string;
  };
}

/**
 * The multi-line input of a note's body, bound to the form field it is given. The field's
 * validation issues show under the input, which takes `aria-invalid` and `aria-describedby` while
 * it has one. The form hook's `TextField` renders a single line, so the body is bound here, inside
 * the notes slice.
 *
 * @param props - The field's props.
 * @param props.field - The `body` field of the note form.
 * @returns The field.
 */
export const BodyField = ({ field }: { readonly field: BodyFieldApi }) => {
  const { errors } = field.state.meta;
  const invalid = errors !== undefined && errors.length > 0;
  const errorId = `${field.name}-error`;

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>Body</FieldLabel>
      <Textarea
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
