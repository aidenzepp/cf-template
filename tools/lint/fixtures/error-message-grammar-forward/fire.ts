import { Schema } from "effect";

class SaveError extends Schema.TaggedError<SaveError>()("SaveError", { message: Schema.String }) {}

export const failure = (cause: unknown) => new SaveError({ message: String(cause) });
