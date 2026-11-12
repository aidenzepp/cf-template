import { useAtom } from "@effect/atom-react";
import { Effect, Exit, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { notify } from "../components/notify.ts";
import { authErrorCopy } from "../lib/auth-error-copy.ts";
import { betterAuthCall } from "../lib/better-auth-call.ts";
import type { Settled } from "../lib/better-auth-call.ts";

/**
 * One action of a settings card: the call, the title of the toast that says it worked, and the
 * title of the toast that says it did not.
 */
export interface Action {
  readonly call: (signal: AbortSignal) => PromiseLike<Settled>;
  readonly done: string;
  readonly failed: string;
}

/**
 * Makes the atom that runs one card's actions, one at a time: a new action interrupts the one in
 * flight. The outcome is a toast; a refusal for a stale session raises none, because the prompt
 * for a fresh sign-in answers it.
 *
 * @returns The atom of a card.
 */
export const actionAtom = () =>
  Atom.fn((action: Action) =>
    betterAuthCall(action.call).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          notify.success(action.done);
        }),
      ),
      Effect.tapErrorTag("AuthCallFailed", ({ error }) =>
        Effect.sync(() => {
          notify.error(action.failed, authErrorCopy({ aborted: false, error }) ?? undefined);
        }),
      ),
    ),
  );

/**
 * Runs a card's actions through its atom. An action the server refuses for a stale session asks for
 * the password through `askFresh`, then runs again.
 *
 * @param atom - The card's atom from `actionAtom`.
 * @param askFresh - Opens the prompt and keeps the action to retry.
 * @returns `act`, which runs an action and then `after` when it succeeded, and whether one is in
 *   flight.
 */
export const useAction = (
  atom: ReturnType<typeof actionAtom>,
  askFresh: (retry: () => void) => void,
) => {
  const [result, submit] = useAtom(atom, { mode: "promiseExit" });

  const act = async (action: Action, after?: () => void): Promise<void> => {
    const exit = await submit(action);

    if (Exit.isSuccess(exit)) {
      after?.();

      return;
    }

    if (Option.exists(Exit.findErrorOption(exit), ({ _tag }) => _tag === "SessionNotFresh")) {
      askFresh(() => {
        void act(action, after);
      });
    }
  };

  return { act, pending: AsyncResult.isWaiting(result) };
};
