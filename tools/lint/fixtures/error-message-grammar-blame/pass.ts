import { Schema } from "effect";

class SaveError extends Schema.TaggedError<SaveError>()("SaveError", { message: Schema.String }) {}

export const failure = new SaveError({ message: "The title is too long: use at most 120 characters." });
