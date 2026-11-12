import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { LAST_METHOD_KEY, readLastMethod, recordMethod } from "./last-method.ts";
import type { MethodStore } from "./last-method.ts";

/**
 * A store in memory, with the keys it holds.
 */
const memory = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));

  const store: MethodStore = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };

  return { items, store };
};

/**
 * The browser's store when site data is blocked: every access throws.
 */
const blocked = (): MethodStore => ({
  getItem: () => "x".repeat(-1),
  setItem: () => {
    void "x".repeat(-1);
  },
});

describe("last sign-in method", () => {
  it.effect("has no record before any sign-in", () =>
    Effect.gen(function* empty() {
      const { store } = memory();

      expect(yield* readLastMethod(() => store)).toStrictEqual(Option.none());
    }),
  );

  it.effect("reads back the method a sign-in recorded, passkey or email", () =>
    Effect.gen(function* recorded() {
      const { store } = memory();

      yield* recordMethod(() => store, "passkey");
      expect(yield* readLastMethod(() => store)).toStrictEqual(Option.some("passkey"));

      yield* recordMethod(() => store, "email");
      expect(yield* readLastMethod(() => store)).toStrictEqual(Option.some("email"));
    }),
  );

  it.effect("stores only the method name under one key", () =>
    Effect.gen(function* only() {
      const { items, store } = memory();

      yield* recordMethod(() => store, "email");

      expect([...items]).toStrictEqual([[LAST_METHOD_KEY, "email"]]);
    }),
  );

  it.effect("treats a value that is not a known method as no record", () =>
    Effect.gen(function* unknown() {
      const { store } = memory({ [LAST_METHOD_KEY]: "ada@example.com" });

      expect(yield* readLastMethod(() => store)).toStrictEqual(Option.none());
    }),
  );

  it.effect("treats a store that throws as no record and a failed write as nothing", () =>
    Effect.gen(function* throwing() {
      expect(yield* readLastMethod(blocked)).toStrictEqual(Option.none());
      yield* recordMethod(blocked, "passkey");
    }),
  );
});
