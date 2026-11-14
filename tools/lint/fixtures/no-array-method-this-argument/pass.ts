import { Effect } from "effect";
import _ from "lodash";

export const each = (xs: ReadonlyArray<number>) =>
  Effect.forEach(xs, (x) => Effect.succeed(x));

export const lodashed = (xs: ReadonlyArray<number>) => _.map(xs, (x) => x * 2);

export const doubled = (xs: ReadonlyArray<number>) => xs.map((x) => x * 2);
