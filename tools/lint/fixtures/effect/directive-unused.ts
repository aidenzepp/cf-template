import { Effect } from "effect";

// oxlint-disable-next-line effecttsgo/floating-effect -- the fixture proves an unused directive fails
export const logged = Effect.log("not floating");
