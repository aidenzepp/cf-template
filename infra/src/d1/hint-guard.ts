import { Effect, Option, Schema } from "effect";
import * as Alchemy from "alchemy";
import { StackName } from "alchemy/Stack";
import { State, isResourceState } from "alchemy/State";
import type { PersistedState } from "alchemy/State";

/**
 * The refusal of a `prod` deploy that would change the primary location hint of a D1 database
 * that already exists.
 *
 * Cloudflare reads the hint only when it creates a database. Alchemy replaces the resource when
 * the hint changes, and the replacement is a new, empty database.
 */
export class D1LocationHintChanged extends Schema.TaggedError<
  D1LocationHintChanged,
  { readonly brand: unique symbol }
>()("D1LocationHintChanged", {
  created: Schema.String,
  database: Schema.String,
  desired: Schema.String,
}) {
  override get message(): string {
    return `Refusing to deploy: the ${this.database} D1 database was created with location hint ${this.created} and D1_PROD_LOCATION_HINT now asks for ${this.desired}. The hint only applies when a database is created; changing it would replace ${this.database} with an empty database. Set D1_PROD_LOCATION_HINT back to ${this.created}.`;
  }
}

/**
 * The hint as the message shows it.
 *
 * @param hint - The hint, or `none` for the unset value.
 * @returns The hint, or `unset`.
 */
const show = (hint: Option.Option<string>): string => Option.getOrElse(hint, () => "unset");

/**
 * The hint a database was created with, from its persisted Alchemy state.
 *
 * @param state - The persisted state of the database resource, if any.
 * @returns `none` when no database was ever recorded, otherwise `some` of the recorded hint.
 */
export const createdHint = (
  state: PersistedState | undefined,
): Option.Option<Option.Option<string>> =>
  isResourceState(state) && state.props !== undefined
    ? Option.some(Option.fromNullishOr(state.props.primaryLocationHint))
    : Option.none();

/**
 * Decide whether a deploy may carry the desired hint for one database.
 *
 * Only `prod` is guarded. A database that was never created accepts any hint, and an existing one
 * accepts only the hint it was created with, so that set to unset and unset to set refuse like a
 * changed hint.
 *
 * @param input - The facts of one database.
 * @param input.database - The database's logical name.
 * @param input.stage - The decoded stage name.
 * @param input.created - The hint the existing database was created with; `none` when there is
 *   no existing database.
 * @param input.desired - The hint the deploy would apply.
 * @returns Success, or {@link D1LocationHintChanged}.
 */
export const decideLocationHint = (input: {
  readonly database: string;
  readonly stage: string;
  readonly created: Option.Option<Option.Option<string>>;
  readonly desired: Option.Option<string>;
}) =>
  input.stage === "prod" &&
  Option.isSome(input.created) &&
  !Option.makeEquivalence<string>((a, b) => a === b)(input.created.value, input.desired)
    ? Effect.fail(
        new D1LocationHintChanged({
          created: show(input.created.value),
          database: input.database,
          desired: show(input.desired),
        }),
      )
    : Effect.void;

/**
 * The store is read from the context with `serviceOption` because the stack program's declared
 * requirements do not list `State`, although the stack builds it before the program runs.
 *
 * Refuse a `prod` deploy that changes the location hint of an existing database, before any
 * resource is declared. Other stages are not read.
 *
 * @param databases - The logical names of the D1 databases the stack declares.
 * @param desired - The `D1_PROD_LOCATION_HINT` knob value.
 * @returns Success, or {@link D1LocationHintChanged} for the first database that would change.
 */
export const guardLocationHints = Effect.fn("guardLocationHints")(function* guardLocationHints(
  databases: ReadonlyArray<string>,
  desired: Option.Option<string>,
) {
  const stage = yield* Alchemy.Stage;

  if (stage !== "prod") {
    return;
  }

  const state = yield* Option.match(yield* Effect.serviceOption(State), {
    onNone: () =>
      Effect.die(
        "The stack program ran without a state store, so the D1 location hint cannot be checked.",
      ),
    onSome: (store) => store,
  });

  const stack = yield* StackName;

  for (const database of databases) {
    const persisted = yield* state.get({ fqn: database, stack, stage });

    yield* decideLocationHint({ created: createdHint(persisted), database, desired, stage });
  }
});
