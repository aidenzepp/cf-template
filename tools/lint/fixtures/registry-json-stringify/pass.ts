import { Schema } from "effect";

export const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ latched: Schema.Boolean })));
