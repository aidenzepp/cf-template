import { Effect } from "effect";
import { AtomRegistry, Hydration } from "effect/reactivity";
import type { AsyncResult, Atom } from "effect/reactivity";

/**
 * Run the query atoms a route needs on the server and return their encoded state.
 *
 * Each call owns one registry. Every atom is mounted, all of them are awaited concurrently, the
 * serializable ones are dehydrated, then the atoms are unmounted and the registry is disposed, so
 * no state outlives the loader call or crosses to another request. A failed atom is not a failed
 * load: its failure is part of the dehydrated state, and the browser renders it. This is the only
 * dehydration site in `apps/web`; query atoms are `Atom.serializable` with a key and an
 * `AsyncResult.Schema`.
 *
 * @param atoms - The query atoms to run.
 * @returns The dehydrated entries of the serializable atoms that left their initial state.
 */
export const loadAtoms = Effect.fn("loadAtoms")(function* loadAtoms(
  atoms: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>,
) {
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (made) =>
      Effect.sync(() => {
        made.dispose();
      }),
  );

  yield* Effect.all(
    atoms.map((atom) => AtomRegistry.mount(registry, atom)),
    { discard: true },
  );
  yield* Effect.all(
    atoms.map((atom) => Effect.ignore(AtomRegistry.getResult(registry, atom))),
    { concurrency: "unbounded", discard: true },
  );

  return Hydration.dehydrate(registry);
}, Effect.scoped);
