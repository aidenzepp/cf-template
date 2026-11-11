import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AdminGuardError, RepositoryError, guardAdmin, resolveRepository } from "./repository.ts";

/**
 * A fake `HttpClient` that answers each path from `routes` and 404s every other path.
 *
 * @param routes - The status and JSON body per request path.
 * @returns The layer providing the client.
 */
const fakeGitHub = (routes: Record<string, { status: number; body: unknown }>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const route = routes[url.pathname] ?? { body: {}, status: 404 };

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(route.body, { status: route.status })),
      );
    }),
  );

/**
 * Provide a config provider built from `values`.
 *
 * @param values - The configuration entries.
 * @returns The layer providing the provider.
 */
const config = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret", ...values }));

const widget = { owner: "acme", repo: "widget" };

/**
 * The repository response for an owner of `type` with the given admin flag.
 *
 * @param admin - The `permissions.admin` value.
 * @returns The 200 route.
 */
const repositoryRoute = (admin: boolean) => ({
  "/repos/acme/widget": {
    body: {
      owner: { login: "acme", type: "Organization" },
      permissions: { admin },
      private: true,
    },
    status: 200,
  },
});

describe("resolveRepository", () => {
  it.effect("parses the origin remote", () =>
    Effect.gen(function* origin() {
      const repository = yield* resolveRepository().pipe(
        Effect.provide(
          config({ STACK_NAME_ORIGIN_COMMAND: "echo git@github.com:acme/widget.git" }),
        ),
      );

      assert.deepStrictEqual(repository, widget);
    }),
  );

  it.effect("prefers GITHUB_REPOSITORY", () =>
    Effect.gen(function* explicit() {
      const repository = yield* resolveRepository().pipe(
        Effect.provide(
          config({
            GITHUB_REPOSITORY: "acme/widget",
            STACK_NAME_ORIGIN_COMMAND: "echo https://github.com/other/thing.git",
          }),
        ),
      );

      assert.deepStrictEqual(repository, widget);
    }),
  );

  it.effect("fails when no source names a repository", () =>
    Effect.gen(function* none() {
      const failure = yield* Effect.flip(
        resolveRepository().pipe(Effect.provide(config({ STACK_NAME_ORIGIN_COMMAND: "false" }))),
      );

      assert.instanceOf(failure, RepositoryError);
    }),
  );
});

describe("guardAdmin", () => {
  it.effect("passes with permissions.admin and reports owner type and visibility", () =>
    Effect.gen(function* admin() {
      const repository = yield* guardAdmin(widget).pipe(
        Effect.provide([fakeGitHub(repositoryRoute(true)), config({})]),
      );

      assert.deepStrictEqual(repository, {
        name: "widget",
        owner: "acme",
        ownerType: "Organization",
        visibility: "private",
      });
    }),
  );

  it.effect("refuses when admin is false", () =>
    Effect.gen(function* notAdmin() {
      const failure = yield* Effect.flip(
        guardAdmin(widget).pipe(Effect.provide([fakeGitHub(repositoryRoute(false)), config({})])),
      );

      assert.instanceOf(failure, AdminGuardError);
    }),
  );

  it.effect("refuses a non-200 status without leaking the token", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(
        guardAdmin(widget).pipe(Effect.provide([fakeGitHub({}), config({})])),
      );

      assert.instanceOf(failure, AdminGuardError);
      assert.include(failure.message, "404");
      assert.notInclude(failure.message, "ghp_secret");
    }),
  );
});
