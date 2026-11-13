import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy, RuntimeContext } from "alchemy";
import { Context, Effect, Layer, Option } from "effect";
import { LiveKnobs, LiveSourceError, fromSource } from "@workspace/config/knob";
import type { LiveKnobsPort } from "@workspace/config/knob";

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
 * The name the knobs namespace is logged under.
 */
const SOURCE_NAME = "knobs namespace";

/**
 * Build the `LiveKnobs` port that reads tier (c) through `read`, on the core `fromSource`.
 *
 * `fromSource` supplies the on-demand read, the per-isolate cache of {@link KNOB_REFRESH_MS} that
 * reuses successes and failures and never shares an in-flight read, the tier (b) fallback, and the
 * once-per-distinct-value `knob.live.rejected` log. This keeps only the adapter from a binding
 * read to a `LiveSource`: `null` becomes `Option.none()` and a failure becomes a
 * `LiveSourceError`. The binding read itself, which takes the request's `RuntimeContext` through
 * `withHostContext`, stays in {@link KnobsKvLive}, because `fromSource` knows no host context.
 *
 * @param read - Read the string stored under a key; `null` when it holds none.
 * @returns The port value that provides `LiveKnobs`.
 */
export const makeKnobsPort = <E>(
  read: (key: string) => Effect.Effect<string | null, E>,
): LiveKnobsPort =>
  fromSource(
    {
      name: SOURCE_NAME,
      read: (key) =>
        read(key).pipe(
          Effect.map(Option.fromNullishOr),
          Effect.mapError((cause) => new LiveSourceError({ cause, source: SOURCE_NAME })),
        ),
    },
    { refreshMs: KNOB_REFRESH_MS },
  );

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
