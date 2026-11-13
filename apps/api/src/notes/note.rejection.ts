import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { NoteId } from "./note.event.ts";

/**
 * The notebook already holds a note with the requested id.
 */
export class NoteAlreadyExists extends Domain.Rejection(
  "NoteAlreadyExists",
  { id: NoteId },
  { description: "The notebook already holds a note with this id.", httpApiStatus: 409 },
) {}

/**
 * The notebook holds no note with the requested id.
 */
export class NoteNotFound extends Domain.Rejection(
  "NoteNotFound",
  { id: NoteId },
  { description: "The notebook holds no note with this id.", httpApiStatus: 404 },
) {}

/**
 * The notebook already holds the most notes one owner may keep.
 */
export class NoteQuotaExceeded extends Domain.Rejection(
  "NoteQuotaExceeded",
  { limit: Schema.Int },
  {
    description: "The notebook already holds the most notes one owner may keep.",
    httpApiStatus: 409,
  },
) {}
