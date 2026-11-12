import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteCreate,
  NotePatch,
} from "@workspace/contract/domain/note";
import { Schema } from "effect";
import { required } from "../../components/form/fields.ts";

/**
 * The fields of the note form, create and edit alike. They carry the contract's limits
 * (`NoteCreate`, `NotePatch`) with a line for each, and a title is not empty. What decodes here
 * also decodes as the contract's request.
 */
export const NoteInput = Schema.Struct({
  body: Schema.String.check(
    Schema.isMaxLength(NOTE_BODY_MAX_LENGTH, {
      message: `Use at most ${NOTE_BODY_MAX_LENGTH} characters.`,
    }),
  ),
  title: required("Enter a title.").check(
    Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH, {
      message: `Use at most ${NOTE_TITLE_MAX_LENGTH} characters.`,
    }),
  ),
});

/**
 * The create request for a decoded form. The API client encodes only the contract's own class.
 *
 * @param input - The decoded form.
 * @returns The request body.
 */
export const noteCreateOf = (input: typeof NoteInput.Type) => new NoteCreate(input);

/**
 * The update request for a decoded form. The API client encodes only the contract's own class.
 *
 * @param input - The decoded form.
 * @returns The request body.
 */
export const notePatchOf = (input: typeof NoteInput.Type) => new NotePatch(input);
