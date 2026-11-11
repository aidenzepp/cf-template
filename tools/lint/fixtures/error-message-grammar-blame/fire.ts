import { Schema } from "effect";

class SaveError extends Schema.TaggedError<SaveError>()("SaveError", { message: Schema.String }) {}

export const failure = new SaveError({ message: "You provided a title that is too long." });
