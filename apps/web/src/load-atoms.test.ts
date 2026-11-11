import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AsyncResult, Atom, Hydration } from "effect/reactivity";
import { loadAtoms } from "./load-atoms.ts";

const TitlesResult = AsyncResult.Schema({ success: Schema.Array(Schema.String) });

const FailingResult = AsyncResult.Schema({ error: Schema.String });

/**
 * A query atom the way a route declares one: serializable under a key, with the schema of its
 * result.
 */
const titles = Atom.make(Effect.succeed<readonly string[]>(["a", "b"])).pipe(
  Atom.serializable({ key: "titles", schema: TitlesResult, skipInitialRun: true }),
);

const failing = Atom.make(Effect.fail("down")).pipe(
  Atom.serializable({ key: "failing", schema: FailingResult, skipInitialRun: true }),
);

const plain = Atom.make(Effect.succeed(1));

const keys = (state: readonly Hydration.DehydratedAtom[]) =>
  Hydration.toValues(state)
    .map((entry) => entry.key)
    .toSorted();

it.effect("dehydrates every serializable atom after awaiting them concurrently", () =>
  Effect.gen(function* dehydrates() {
    const state = yield* loadAtoms([titles, failing, plain]);

    expect(keys(state)).toStrictEqual(["failing", "titles"]);
    expect(Hydration.toValues(state).find((entry) => entry.key === "titles")?.value).toMatchObject({
      _tag: "Success",
      value: ["a", "b"],
      waiting: false,
    });
  }),
);

it.effect("carries a failed atom in the state instead of failing the load", () =>
  Effect.gen(function* carriesFailure() {
    const state = yield* loadAtoms([failing]);
    const entry = Hydration.toValues(state).find((candidate) => candidate.key === "failing");

    expect(entry?.value).toMatchObject({ _tag: "Failure" });
  }),
);

it.effect("gives each call its own registry, so nothing leaks between loader calls", () =>
  Effect.gen(function* isolates() {
    const first = yield* loadAtoms([titles]);
    const second = yield* loadAtoms([]);

    expect(keys(first)).toStrictEqual(["titles"]);
    expect(second).toStrictEqual([]);
  }),
);
