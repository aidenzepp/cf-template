import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Effect, Layer, Predicate, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { GuardKv, GuardKvError } from "./reset.ts";

/**
 * Wrap a failure of `operation` as a {@link GuardKvError} naming its tag and message, never its
 * request.
 */
const failed =
  (operation: string) =>
  (cause: unknown): GuardKvError =>
    new GuardKvError({
      message: `Cloudflare ${operation} failed: ${Predicate.hasProperty(cause, "_tag") ? String(cause._tag) : "unknown error"}${Predicate.hasProperty(cause, "message") ? `, ${String(cause.message)}` : ""}.`,
    });

/**
 * Build Alchemy's authenticated Cloudflare layer, which resolves the profile or the CI environment
 * on first use, and return a runner of one operation against the account.
 *
 * The undocumented subpaths this depends on are `@alchemy.run/cloudflare/Providers`
 * (`CloudflareApiLive`), `alchemy/Auth/Registry` (`AuthProvidersLive`) and
 * `@distilled.cloud/cloudflare/kv`. It never reads, parses or prints a profile, a token or an
 * account id source.
 *
 * @returns `call`, which runs `run` with the account id and maps any failure to a
 *   {@link GuardKvError} that names `operation`.
 */
const accountClient = Effect.gen(function* buildAccountClient() {
  const context = yield* Layer.build(
    Layer.provide(
      CloudflareApiLive(),
      Layer.mergeAll(BunServices.layer, AuthProvidersLive, FetchHttpClient.layer),
    ),
  );

  const accountId = Cloudflare.CloudflareEnvironment.current.pipe(
    Effect.map((environment) => environment.accountId),
    Effect.provideContext(context),
  );

  const call = <A, E, R>(operation: string, run: (id: string) => Effect.Effect<A, E, R>) =>
    accountId.pipe(
      Effect.flatMap(run),
      Effect.provideContext(context),
      Effect.mapError(failed(operation)),
    );

  return { call };
});

/**
 * The real client of the reset command: the account's namespace listing and one key delete.
 */
export const GuardKvLive = Layer.effect(
  GuardKv,
  Effect.gen(function* buildGuardKv() {
    const { call } = yield* accountClient;

    return GuardKv.of({
      findNamespaces: (title) =>
        call("namespace listing", (id) =>
          kv.listNamespaces.items({ accountId: id }).pipe(
            Stream.filter((namespace) => namespace.title === title),
            Stream.map((namespace) => ({ id: namespace.id, title: namespace.title })),
            Stream.runCollect,
          ),
        ),
      remove: (namespaceId, key) =>
        call(`delete of ${key}`, (id) =>
          kv.deleteNamespaceValue({ accountId: id, keyName: key, namespaceId }),
        ).pipe(Effect.asVoid),
    });
  }),
);
