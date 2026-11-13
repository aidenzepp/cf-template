import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy, RuntimeContext } from "alchemy";
import { Clock, Context, Effect, Exit, Layer, Option } from "effect";
import { LiveKnobs } from "@workspace/config/knob";
import type { Knob, LiveKnobsPort } from "@workspace/config/knob";

/**
 * How long a read result, success or failure, is reused before the next request reads the key
 * again, in milliseconds. A constant, not a knob.
 */
export const KNOB_REFRESH_MS = 30_000;

/**
 * The `cacheTtl` of each KV read, in seconds: the shortest Workers KV accepts below a minute is 30.
 * A constant, not a knob.
 */
const KV_CACHE_TTL_S = 30;

/**
 * The logical id of the namespace resource, the key of its Alchemy state. `infra` declares it under
 * this id and every Worker binds it by the same id.
 */
const KNOBS_NAMESPACE_ID = "KnobsKv";

/**
 * The title of a stage's knobs namespace: `<stackName>-<stage>-knobs`.
 *
 * The one place the title is computed; the declaration and the `knob` command both use it.
 *
 * @param stackName - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @returns The namespace title.
 */
export const knobsNamespaceTitle = (stackName: string, stage: string): string =>
  `${stackName}-${stage}-knobs`;

/**
 * Declare the knobs namespace of a stage: one classic KV namespace titled by
 * {@link knobsNamespaceTitle}, destroyed with its resource on every stage except `prod`, which
 * retains it so a deleted stack never loses an operator's overrides.
 *
 * @param stackName - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @returns The namespace resource effect.
 */
export const knobsNamespace = (stackName: string, stage: string) =>
  Cloudflare.KV.Namespace(KNOBS_NAMESPACE_ID, {
    title: knobsNamespaceTitle(stackName, stage),
  }).pipe(RemovalPolicy.retain(stage === "prod"));

/**
 * One cached read: when it ran and how it ended.
 */
interface CachedRead<E> {
  readonly at: number;
  readonly exit: Exit.Exit<string | null, E>;
}

/**
 * Run a read that needs the host context of the request in progress.
 *
 * The binding's methods are typed with `RuntimeContext`, which the request fiber of a Worker
 * already holds. The reader a knob returns has no requirements, so this takes the context from the
 * fiber, and a fiber without one is a defect.
 *
 * @param call - The read on the binding.
 * @returns The read with `RuntimeContext` taken from the current fiber.
 */
const withHostContext = <A, E>(call: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
  Effect.contextWith((context) =>
    Option.match(Context.getOption(context, RuntimeContext), {
      onNone: () => Effect.die("The request fiber carries no RuntimeContext."),
      onSome: (host) => Effect.provideService(call, RuntimeContext, host),
    }),
  );

/**
 * Build the `LiveKnobs` port that reads tier (c) through `read`.
 *
 * Each key is read at most once per {@link KNOB_REFRESH_MS}, and the exit of that read is cached,
 * so a failing store is retried after the same interval as a healthy one. An in-flight read is
 * never shared: two concurrent requests that both miss the cache both read. An absent or empty
 * value, a failed read and a value the knob's schema rejects all yield the tier (b) value. A
 * rejected value logs `knob.live.rejected` once per key at level `error`. The cache and the set of
 * rejected keys belong to the returned port, so they last as long as the isolate that built it.
 *
 * @param read - Read the string stored under a key; `null` when it holds none.
 * @returns The port value that provides `LiveKnobs`.
 */
export const makeKnobsPort = <E>(
  read: (key: string) => Effect.Effect<string | null, E>,
): LiveKnobsPort => {
  const cache = new Map<string, CachedRead<E>>();
  const rejected = new Set<string>();

  const cachedRead = Effect.fn("knobs-kv.cachedRead")(function* cachedRead(key: string) {
    const now = yield* Clock.currentTimeMillis;
    const hit = cache.get(key);

    if (hit !== undefined && now - hit.at < KNOB_REFRESH_MS) {
      return hit.exit;
    }

    const exit = yield* Effect.exit(read(key));

    cache.set(key, { at: now, exit });

    if (Exit.isFailure(exit)) {
      yield* Effect.logWarning(`The knobs namespace failed reading ${key}.`, exit.cause);
    }

    return exit;
  });

  const reject = (key: string) => {
    if (rejected.has(key)) {
      return Effect.void;
    }

    rejected.add(key);

    return Effect.logError("knob.live.rejected").pipe(
      Effect.annotateLogs({ "knob.key": key, [`knob.${key}.reason`]: "schema_rejected" }),
    );
  };

  return {
    bind: <A>(knob: Knob<A>) =>
      knob.config.pipe(
        Effect.map((base): Effect.Effect<A> =>
          Effect.gen(function* reader() {
            const exit = yield* cachedRead(knob.key);

            if (Exit.isFailure(exit) || exit.value === null || exit.value === "") {
              return base;
            }

            return yield* knob
              .decode(exit.value)
              .pipe(Effect.catch(() => reject(knob.key).pipe(Effect.as(base))));
          }),
        ),
      ),
  };
};

/**
 * Provide `LiveKnobs` from the stage's knobs namespace, bound read-only.
 *
 * Each key is read with `cacheTtl` {@link KV_CACHE_TTL_S} and refreshed at most once per
 * {@link KNOB_REFRESH_MS} per isolate; see {@link makeKnobsPort}. The binding type stays private
 * to this module, and no Worker holds a write client.
 */
export const KnobsKvLive = Layer.effect(
  LiveKnobs,
  Effect.gen(function* buildKnobsKv() {
    const namespace = yield* Cloudflare.KV.ReadNamespace(
      Cloudflare.KV.Namespace(KNOBS_NAMESPACE_ID),
    ).pipe(Effect.provide(Cloudflare.KV.ReadNamespaceBinding));

    return makeKnobsPort((key) =>
      withHostContext(namespace.get(key, { cacheTtl: KV_CACHE_TTL_S })),
    );
  }),
);
