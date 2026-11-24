import { Effect, Option } from "effect";
import { CredentialsError, STEP_22 } from "./model.ts";
import type { FrozenIdentity, RepositoryView } from "./model.ts";

/**
 * What sub-step 2 decides: the stack to use, whether to run the collision check, and the identity
 * to declare.
 */
export type PinDecision =
  | { readonly kind: "first"; readonly stack: string }
  | { readonly kind: "resume"; readonly stack: string; readonly identity: FrozenIdentity };

/**
 * Apply the re-run table to the live pin and the bootstrap record.
 *
 * Pin present with a matching id declares the frozen identity; pin present with another id
 * refuses; pin absent with a record is a hand deletion and refuses; pin absent with no record is a
 * first run. `--force` turns each refusal into a declaration of the live identity.
 *
 * @param input - The derived name, the pin, the record, the live repository and `--force`.
 * @param input.derived - The derived stack name.
 * @param input.pin - The live `STACK_NAME` variable.
 * @param input.record - The `<stack>-bootstrap` record under the pin, or under the derived name.
 * @param input.live - The repository as the API answers it.
 * @param input.force - Whether `--force` was passed.
 * @returns The decision, or the refusal naming the repair.
 */
export const decidePin = (input: {
  readonly derived: string;
  readonly pin: Option.Option<string>;
  readonly record: Option.Option<FrozenIdentity>;
  readonly live: RepositoryView;
  readonly force: boolean;
}): Effect.Effect<PinDecision, CredentialsError> => {
  const stack = Option.getOrElse(input.pin, () => input.derived);
  const live = { repository: input.live.fullName, repositoryId: input.live.id };

  if (Option.isSome(input.record)) {
    const frozen = input.record.value;

    if (frozen.repositoryId === input.live.id && Option.isSome(input.pin)) {
      return Effect.succeed({ identity: frozen, kind: "resume", stack });
    }

    if (input.force) {
      return Effect.succeed({ identity: live, kind: "resume", stack });
    }

    return Effect.fail(
      new CredentialsError({
        message: Option.isSome(input.pin)
          ? `The repository id ${input.live.id} differs from id ${frozen.repositoryId} frozen in ${stack}-bootstrap. Refusing; repair only with \`bun run credentials --profile admin --force\`. ${STEP_22}`
          : `STACK_NAME is not set on the repository but the store ${stack}-state holds a ${stack}-bootstrap record: the variable was deleted by hand. Restore it, or re-declare it with \`bun run credentials --profile admin --force\`. ${STEP_22}`,
      }),
    );
  }

  if (Option.isSome(input.pin) && !input.force) {
    return Effect.fail(
      new CredentialsError({
        message: `STACK_NAME is pinned to ${stack} but the store ${stack}-state holds no ${stack}-bootstrap record. Refusing; re-declare it with \`bun run credentials --profile admin --force\`. ${STEP_22}`,
      }),
    );
  }

  return Effect.succeed({ kind: "first", stack });
};

/**
 * The collision rule: any `<stack>-` Worker or D1 database other than the store refuses by name;
 * the store `<stack>-state` with this bootstrap's record is a resume; the store with no record
 * refuses and names the two repairs.
 *
 * @param stack - The stack name.
 * @param names - The account's Worker and D1 names with the `<stack>-` prefix.
 * @param hasRecord - Whether the store holds the `<stack>-bootstrap` record.
 * @returns `clear` or `resume`, or the refusal.
 */
export const collision = (
  stack: string,
  names: ReadonlyArray<string>,
  hasRecord: boolean,
): Effect.Effect<"clear" | "resume", CredentialsError> => {
  const store = `${stack}-state`;
  const taken = names.find((name) => name.startsWith(`${stack}-`) && name !== store);

  if (taken !== undefined) {
    return Effect.fail(
      new CredentialsError({
        message: `${taken} already exists on the account, so the stack name ${stack} collides with another project. Choose another name with STACK_NAME and run again. ${STEP_22}`,
      }),
    );
  }

  if (!names.includes(store)) {
    return Effect.succeed("clear");
  }

  return hasRecord
    ? Effect.succeed("resume")
    : Effect.fail(
        new CredentialsError({
          message: `The Worker ${store} exists but this run found no ${stack}-bootstrap record in it. Check first, from the repository root: \`STACK_NAME=${stack} bun run alchemy state list --config infra/alchemy.run.ts --profile admin\`. If it lists ${stack}-bootstrap/, the store is this project's: do not destroy it, and report the failed lookup. Only if it does not, and ${store} is a leftover of another project, destroy ${store}, which deletes every stage's state in it, or choose another name with STACK_NAME, then run again. ${STEP_22}`,
        }),
      );
};

/**
 * Whether `alchemy state list` output names the `<stack>-bootstrap` stack. A top-level listing
 * prints one stack per line with a trailing slash (`cf-template-bootstrap/`), as Alchemy's
 * `listState` returns it.
 *
 * @param stdout - The `alchemy state list` output.
 * @param stack - The stack name.
 * @returns Whether the bootstrap stack is listed.
 */
export const listsBootstrapRecord = (stdout: string, stack: string): boolean =>
  stdout.split("\n").some((line) => line.trim() === `${stack}-bootstrap/`);

/**
 * The JSON value in `alchemy state read` output for one key. The command prints the value as
 * `JSON.stringify(value, null, 2)`, a top-level `{` line through its closing `}`, but the CLI's
 * plain renderer also writes task lines (`• Refreshing Cloudflare State Store credentials`, then
 * `✓ ...`) and, outside JSON log format, log records to stdout first. This keeps the text from the
 * last line that is exactly `{`.
 *
 * @param stdout - The `alchemy state read` output.
 * @returns The JSON text, or the whole output when no line is `{`.
 */
export const stateReadJson = (stdout: string): string => {
  const lines = stdout.split("\n");
  const start = lines.lastIndexOf("{");

  return start === -1 ? stdout : lines.slice(start).join("\n");
};
