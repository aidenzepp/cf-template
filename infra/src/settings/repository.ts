import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { parseRepository, readOrigin } from "../stack-name.ts";

/**
 * The failure of repository resolution: neither `GITHUB_REPOSITORY` nor the `origin` remote names
 * an `owner/repo`.
 */
export class RepositoryError extends Schema.TaggedError<
  RepositoryError,
  { readonly brand: unique symbol }
>()("RepositoryError", {
  message: Schema.String,
}) {}

/**
 * The failure of a GitHub read: the transport failed, the status was not 200, or the body did not
 * decode. Carries no token.
 */
class GitHubRequestError extends Schema.TaggedError<
  GitHubRequestError,
  { readonly brand: unique symbol }
>()("GitHubRequestError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
}) {}

/**
 * The refusal of the admin guard: the repository is unreadable or the token lacks
 * `permissions.admin`. Nothing may be written after it.
 */
export class AdminGuardError extends Schema.TaggedError<
  AdminGuardError,
  { readonly brand: unique symbol }
>()("AdminGuardError", {
  message: Schema.String,
}) {}

/**
 * The refusal of {@link refuseAmbientCredentials}: an environment variable could make the
 * `@alchemy.run/github` provider authenticate as, or talk to, something the admin guard never
 * checked.
 */
export class AmbientCredentialsError extends Schema.TaggedError<
  AmbientCredentialsError,
  { readonly brand: unique symbol }
>()("AmbientCredentialsError", { message: Schema.String }) {}

/**
 * The one token of a settings run: the admin guard, the REST calls and the provider all use it.
 */
export const githubToken = Config.Redacted("GITHUB_TOKEN");

/**
 * The variables the GitHub provider reads on its own: a second token that wins over `GITHUB_TOKEN`
 * and three that move it to an enterprise host.
 */
const AMBIENT_VARIABLES = [
  "GITHUB_ACCESS_TOKEN",
  "GH_HOST",
  "GITHUB_BASE_URL",
  "GITHUB_API_URL",
] as const;

/**
 * The public API endpoint. GitHub Actions sets `GITHUB_API_URL` to it on every runner, so
 * `GITHUB_API_URL` is refused only when it names something else.
 */
const PUBLIC_API_URL = "https://api.github.com";

/**
 * Whether a set variable is the public default that Actions runners provide: only
 * `GITHUB_API_URL`, only {@link PUBLIC_API_URL}, ignoring one trailing slash.
 *
 * @param name - The variable name.
 * @param value - The value it is set to.
 * @returns True when the value moves nothing off github.com.
 */
const isPublicDefault = (name: string, value: string) =>
  name === "GITHUB_API_URL" && value.replace(/\/$/u, "") === PUBLIC_API_URL;

/**
 * Refuse to start when any provider-side credential or host variable is set, except the public
 * default `GITHUB_API_URL`. Runs before any network call; the message names the variable and never
 * its value.
 *
 * @returns Nothing, or an {@link AmbientCredentialsError} naming the first variable set.
 */
export const refuseAmbientCredentials = Effect.fn("refuseAmbientCredentials")(
  function* refuseAmbientCredentials() {
    yield* Effect.forEach(
      AMBIENT_VARIABLES,
      Effect.fn(function* checkVariable(name) {
        const value = yield* Config.String(name).pipe(Config.option);

        return yield* Option.isSome(value) && !isPublicDefault(name, value.value)
          ? new AmbientCredentialsError({
              message: `${name} is set. The settings run uses only GITHUB_TOKEN on github.com; unset ${name} and run again.`,
            })
          : Effect.void;
      }),
      { discard: true },
    );
  },
);

/**
 * The fields of `GET /repos/{owner}/{name}` the settings program reads.
 */
const RepositoryResponse = Schema.Struct({
  owner: Schema.Struct({ login: Schema.String, type: Schema.String }),
  permissions: Schema.optional(Schema.Struct({ admin: Schema.Boolean })),
  private: Schema.Boolean,
});

/**
 * A repository whose admin guard passed.
 */
export interface GuardedRepository {
  readonly owner: string;
  readonly name: string;
  readonly ownerType: string;
  readonly visibility: "public" | "private";
}

/**
 * Resolve `owner` and `repo`: `GITHUB_REPOSITORY` when set, else the `origin` remote, parsed by
 * the same `parseRepository` that `resolveStackName` uses.
 *
 * @returns The owner and repository, or a {@link RepositoryError} when neither source names one.
 */
export const resolveRepository = Effect.fn("resolveRepository")(function* resolveRepository() {
  const configured = yield* Config.String("GITHUB_REPOSITORY").pipe(Config.option);
  const source = Option.isSome(configured) ? configured : yield* readOrigin();
  const repository = source.pipe(Option.flatMap(parseRepository));

  return Option.isSome(repository)
    ? repository.value
    : yield* new RepositoryError({
        message:
          "Cannot resolve the repository: GITHUB_REPOSITORY is unset and `git remote get-url origin` returned no owner/repo. Set GITHUB_REPOSITORY or add an origin remote.",
      });
}, Effect.provide(BunServices.layer));

/**
 * Read a GitHub REST path with the `GITHUB_TOKEN` bearer token and decode a 200 body.
 *
 * @param path - The API path, such as `/user`.
 * @param schema - The schema of the fields the caller reads.
 * @returns The decoded body, or a {@link GitHubRequestError} naming the path and the problem.
 */
export const getJson = Effect.fn("getJson")(function* getJson<S extends Schema.Constraint>(
  path: string,
  schema: S,
) {
  const token = yield* githubToken;

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
      ),
    ),
  );

  const response = yield* client
    .get(path)
    .pipe(
      Effect.mapError(
        (cause) =>
          new GitHubRequestError({ cause, message: `GET ${path} did not complete.`, path }),
      ),
    );

  if (response.status !== 200) {
    return yield* new GitHubRequestError({
      message: `GET ${path} returned ${response.status}.`,
      path,
    });
  }

  return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(
      (cause) =>
        new GitHubRequestError({
          cause,
          message: `GET ${path} returned a body that does not match the expected fields.`,
          path,
        }),
    ),
  );
});

/**
 * Refuse unless `GET /repos/{owner}/{name}` returns 200 with `permissions.admin: true` for the
 * token. The check never compares a login, so organization owners pass.
 *
 * @param repository - The owner and repository name.
 * @param repository.owner - The repository owner.
 * @param repository.repo - The repository name.
 * @returns The repository's owner type and visibility, or an {@link AdminGuardError}.
 */
export const guardAdmin = Effect.fn("guardAdmin")(function* guardAdmin(repository: {
  readonly owner: string;
  readonly repo: string;
}) {
  const slug = `${repository.owner}/${repository.repo}`;

  const response = yield* getJson(`/repos/${slug}`, RepositoryResponse).pipe(
    Effect.mapError(
      (failure) =>
        new AdminGuardError({ message: `${failure.message} Admin access to ${slug} is required.` }),
    ),
  );

  if (response.permissions?.admin !== true) {
    return yield* new AdminGuardError({
      message: `The token has no admin permission on ${slug}. Use a token for a repository admin.`,
    });
  }

  return {
    name: repository.repo,
    owner: repository.owner,
    ownerType: response.owner.type,
    visibility: response.private ? "private" : "public",
  } satisfies GuardedRepository;
});
