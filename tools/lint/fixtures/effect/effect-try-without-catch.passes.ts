import { Effect } from "effect";

export const attempt = Effect.try({ catch: (cause) => String(cause), try: () => 1 });
