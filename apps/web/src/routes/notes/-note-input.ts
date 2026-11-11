import { NoteCreate, NotePatch } from "@workspace/contract/domain/note";
import { Schema } from "effect";
import type { Option } from "effect";

const decodeNoteCreate = Schema.decodeUnknownOption(NoteCreate);

/**
 * Read a submitted form with the contract's request schema.
 *
 * @param form - The submitted form's data.
 * @returns The request body, or none when the form does not decode.
 */
export const readNoteCreate = (form: FormData): Option.Option<NoteCreate> =>
  decodeNoteCreate({ body: form.get("body"), title: form.get("title") });

const decodeNotePatch = Schema.decodeUnknownOption(NotePatch);

/**
 * Read a submitted edit form with the contract's update request schema.
 *
 * @param form - The submitted form's data.
 * @returns The request body, or none when the form does not decode.
 */
export const readNotePatch = (form: FormData): Option.Option<NotePatch> =>
  decodeNotePatch({ body: form.get("body"), title: form.get("title") });
