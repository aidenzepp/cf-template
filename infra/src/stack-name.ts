import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, Schema } from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { STACK_NAME_MAX, base32Sha256, kindOf } from "../stages.ts";
import type { StageName } from "../stages.ts";

/**
 * The failure of stack-name derivation: every source is absent, or the derived name is not a
 * valid stack name.
 */
export class StackNameError extends Schema.TaggedError<StackNameError>()("StackNameError", {
  message: Schema.String,
}) {}

/**
 * The shape every stack name has: lower case alphanumerics and `-`, at least three characters,
 * starting and ending with an alphanumeric.
 */
const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,}[a-z0-9]$/u;

/**
 * The base32 characters of `sha256(owner/repo)` that end a truncated stack name.
 */
const HASH_SUFFIX_LENGTH = 6;

/**
 * The command that reads the `origin` remote URL when `STACK_NAME_ORIGIN_COMMAND` does not
 * override it.
 */
const DEFAULT_ORIGIN_COMMAND = "git remote get-url origin";

/**
 * The text of the failure when no source names the stack.
 */
const NO_SOURCE_MESSAGE =
  "Cannot derive the stack name: STACK_NAME is unset, GITHUB_REPOSITORY is unavailable (it is read only when GITHUB_EVENT_NAME is workflow_dispatch) and `git remote get-url origin` returned no URL. Set STACK_NAME, or add an origin remote to the checkout.";

/**
 * Extract `owner` and `repo` from `owner/repo`, an HTTPS URL, an SSH URL or an SSH URL with a
 * host alias, with or without the `.git` suffix.
 *
 * @param text - The repository reference.
 * @returns The owner and repository, or none when the text has neither form.
 */
const parseRepository = (
  text: string,
): Option.Option<{ readonly owner: string; readonly repo: string }> => {
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/iu.exec(
      text,
    ) ??
    /^(?:[^@/]+@)?[^:/]+:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(text) ??
    /^(?<owner>[^/:@]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(text);

  const { owner, repo } = match?.groups ?? {};

  return owner === undefined || repo === undefined ? Option.none() : Option.some({ owner, repo });
};

/**
 * Normalize a repository name to the stack-name shape and bound.
 *
 * The name is lower-cased, characters outside `[a-z0-9-]` become `-`, and edge `-` are trimmed.
 * When it exceeds {@link STACK_NAME_MAX}, the first `STACK_NAME_MAX - 6` characters are followed
 * by 6 base32 characters of `sha256(owner/repo)`.
 *
 * @param repository - The owner and repository the name comes from.
 * @param repository.owner - The repository owner.
 * @param repository.repo - The repository name.
 * @returns The stack name, or the failure when the name cannot take the stack-name shape.
 */
const normalize = Effect.fn("normalize")(function* normalize(repository: {
  readonly owner: string;
  readonly repo: string;
}) {
  const name = repository.repo
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  const bounded =
    name.length > STACK_NAME_MAX
      ? `${name.slice(0, STACK_NAME_MAX - HASH_SUFFIX_LENGTH)}${yield* base32Sha256(`${repository.owner}/${repository.repo}`, HASH_SUFFIX_LENGTH)}`
      : name;

  return STACK_NAME_PATTERN.test(bounded)
    ? bounded
    : yield* new StackNameError({
        message: `Repository name ${repository.repo} does not form a stack name (lower case letters, digits and -, 3 to ${STACK_NAME_MAX} characters). Set STACK_NAME to a valid name.`,
      });
});

/**
 * Read the `origin` remote URL by running the origin command inside the Effect.
 *
 * @returns The trimmed URL, or none when the command fails or prints nothing.
 */
const readOrigin = Effect.fn("readOrigin")(function* readOrigin() {
  const command = yield* Config.String("STACK_NAME_ORIGIN_COMMAND").pipe(
    Config.withDefault(DEFAULT_ORIGIN_COMMAND),
  );

  const [program = "git", ...args] = command.split(/\s+/u);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(ChildProcess.make(program, args)).pipe(Effect.option);

  return output.pipe(
    Option.map((text) => text.trim()),
    Option.filter((text) => text !== ""),
  );
});

/**
 * Derive the stack name once, in this order: the `STACK_NAME` override, `GITHUB_REPOSITORY` when
 * `GITHUB_EVENT_NAME` is `workflow_dispatch`, then the `origin` remote URL.
 *
 * There is no package-name or directory fallback. The result matches
 * `^[a-z0-9][a-z0-9-]{1,}[a-z0-9]$` and is at most {@link STACK_NAME_MAX} characters, ending in a
 * hash of `owner/repo` only when the repository name was truncated.
 *
 * @returns The stack name, or a {@link StackNameError} naming the three sources when all are
 *   absent.
 */
export const resolveStackName = Effect.fn("resolveStackName")(
  function* resolveStackName() {
    const override = yield* Config.String("STACK_NAME").pipe(Config.option);

    if (Option.isSome(override)) {
      return STACK_NAME_PATTERN.test(override.value) && override.value.length <= STACK_NAME_MAX
        ? override.value
        : yield* new StackNameError({
            message: `STACK_NAME ${override.value} is not a valid stack name (lower case letters, digits and -, 3 to ${STACK_NAME_MAX} characters, starting and ending with a letter or digit). Set it to a valid name.`,
          });
    }

    const event = yield* Config.String("GITHUB_EVENT_NAME").pipe(Config.option);
    const dispatched = Option.isSome(event) && event.value === "workflow_dispatch";

    const github = dispatched
      ? yield* Config.String("GITHUB_REPOSITORY").pipe(Config.option)
      : Option.none<string>();

    const origin = Option.isSome(github) ? Option.none<string>() : yield* readOrigin();

    const repository = Option.flatMap(
      Option.orElse(github, () => origin),
      parseRepository,
    );

    if (Option.isNone(repository)) {
      return yield* new StackNameError({ message: NO_SOURCE_MESSAGE });
    }

    return yield* normalize(repository.value);
  },
  Effect.mapError((failure) =>
    failure instanceof StackNameError
      ? failure
      : new StackNameError({ message: `Cannot read the stack name sources: ${failure.message}` }),
  ),
  Effect.provide([BunServices.layer, Digest.layerWebCrypto]),
);

/**
 * Report whether a cloud deploy of the stage reads the pinned `STACK_NAME` as required `Config`.
 *
 * `prod`, `staging-<N>` and `test-ci` require the pin. `test-<slug>` stages derive the name
 * without it, and the local stage never deploys.
 *
 * @param stage - The decoded stage.
 * @returns True when the stage requires the pin.
 */
export const requiresStackNamePin = (stage: StageName): boolean =>
  kindOf(stage) === "prod" || kindOf(stage) === "staging" || stage === "test-ci";
