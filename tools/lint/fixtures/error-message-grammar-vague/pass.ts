import { Schema } from "effect";

class SaveError extends Schema.TaggedError<SaveError>()("SaveError", { message: Schema.String }) {}

export const failure = new SaveError({ message: "Could not save the note: the database is full." });
