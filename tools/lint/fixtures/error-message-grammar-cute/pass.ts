import { Schema } from "effect";

class SaveError extends Schema.TaggedError<SaveError>()("SaveError", { message: Schema.String }) {}

export const failure = new SaveError({ message: "The note was not saved: the database is full." });
