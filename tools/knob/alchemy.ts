import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Context, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

/**
 * The failure of a Cloudflare call the command made, with the operation that failed.
 */
export class KnobKvError extends Schema.TaggedError<KnobKvError>()("KnobKvError", {
  message: Schema.String,
}) {}

/**
 * A namespace the account lists: its id and exact title.
 */
export interface NamespaceRef {
  readonly id: string;
  readonly title: string;
}

/**
 * One stored key: its name and its string value.
 */
export interface StoredKey {
  readonly key: string;
  readonly value: string;
}

/**
 * The metadata `set` writes beside a value: when it was written.
 */
export interface StoredMetadata {
  readonly setAt: string;
}

/**
 * The calls the `knob` command makes on the stage's namespace, and no others.
 */
export interface KnobKvClient {
  /**
   * Every namespace of the account whose title equals `title`.
   */
  readonly findNamespaces: (
    title: string,
  ) => Effect.Effect<ReadonlyArray<NamespaceRef>, KnobKvError>;
  /**
   * Write `value` under `key` with `metadata`.
   */
  readonly put: (
    namespaceId: string,
    key: string,
    value: string,
    metadata: StoredMetadata,
  ) => Effect.Effect<void, KnobKvError>;
  /**
   * Delete `key`; deleting an absent key succeeds.
   */
  readonly remove: (namespaceId: string, key: string) => Effect.Effect<void, KnobKvError>;
  /**
   * Every key of the namespace with its value.
   */
  readonly stored: (namespaceId: string) => Effect.Effect<ReadonlyArray<StoredKey>, KnobKvError>;
}

/**
 * The Cloudflare client of the command. Tests provide a fake; `KnobKvLive` provides the real one.
 */
export class KnobKv extends Context.Service<KnobKv, KnobKvClient>()("tools/knob/KnobKv") {}

/**
 * Wrap a failure of `operation` as a {@link KnobKvError} naming its tag and message, never its
 * request.
 */
const failed =
  (operation: string) =>
  (cause: unknown): KnobKvError =>
    new KnobKvError({
      message: `Cloudflare ${operation} failed: ${Predicate.hasProperty(cause, "_tag") ? String(cause._tag) : "unknown error"}${Predicate.hasProperty(cause, "message") ? `, ${String(cause.message)}` : ""}.`,
    });

/**
 * The real client: Alchemy's authenticated Cloudflare layer, which resolves the profile or the CI
 * environment on first use, behind the raw KV operations of `@distilled.cloud/cloudflare`.
 *
 * The undocumented subpaths this command depends on are `@alchemy.run/cloudflare/Providers`
 * (`CloudflareApiLive`), `alchemy/Auth/Registry` (`AuthProvidersLive`) and
 * `@distilled.cloud/cloudflare/kv`; `alchemy.fixture.ts` fails the type check when one changes.
 * The command never reads, parses or prints a profile, a token or an account id source.
 */
export const KnobKvLive = Layer.effect(
  KnobKv,
  Effect.gen(function* buildKnobKv() {
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

    return KnobKv.of({
      findNamespaces: (title) =>
        call("namespace listing", (id) =>
          kv.listNamespaces.items({ accountId: id }).pipe(
            Stream.filter((namespace) => namespace.title === title),
            Stream.map((namespace) => ({ id: namespace.id, title: namespace.title })),
            Stream.runCollect,
          ),
        ),
      put: (namespaceId, key, value, metadata) =>
        call(`write of ${key}`, (id) =>
          kv.putNamespaceValue({ accountId: id, keyName: key, metadata, namespaceId, value }),
        ).pipe(Effect.asVoid),
      remove: (namespaceId, key) =>
        call(`delete of ${key}`, (id) =>
          kv.deleteNamespaceValue({ accountId: id, keyName: key, namespaceId }),
        ).pipe(Effect.asVoid),
      stored: (namespaceId) =>
        call("key listing", (id) =>
          kv.listNamespaceKeys.items({ accountId: id, namespaceId }).pipe(
            Stream.mapEffect((entry) =>
              kv.getNamespaceValue({ accountId: id, keyName: entry.name, namespaceId }).pipe(
                Effect.flatMap((response) => Stream.mkString(Stream.decodeText(response.body))),
                Effect.map((value) => ({ key: entry.name, value })),
              ),
            ),
            Stream.runCollect,
          ),
        ),
    });
  }),
);
