import { Effect } from "effect";

export const visit = (xs: ReadonlyArray<number>) =>
  Effect.forEach(xs, (x) => Effect.logInfo(String(x)), { discard: true });

export const optional = (xs: ReadonlyArray<number> | undefined, ctx: object) =>
  xs?.forEach?.((x) => x, ctx);

export const spread = (xs: ReadonlyArray<number>, rest: ReadonlyArray<object>) =>
  xs.map((x) => x, ...rest);

export const notCallback = (xs: ReadonlyArray<number>, ctx: object) => xs.map(1 + 2, ctx);
