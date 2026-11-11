import { Context, Predicate } from "effect";
import type { Effect } from "effect";

/**
 * The calls a layer makes on a plain Workers KV binding: it reads one key.
 */
export interface KvReader {
  readonly get: (key: string) => Promise<string | null>;
}

/**
 * Whether a value of a Worker's `env` can read a KV key.
 *
 * @param value - What the `env` holds under a binding's name.
 * @returns `true` when it has a `get` function.
 */
export const isKvReader = (value: unknown): value is KvReader =>
  Predicate.hasProperty(value, "get") && typeof value.get === "function";

/**
 * The bindings of the Worker that builds a layer, read by name. A layer that needs a plain binding
 * reads it from here, so it never imports the runtime that supplies it.
 */
export class WorkerBindings extends Context.Service<
  WorkerBindings,
  {
    /**
     * The KV binding the Worker's `env` holds under `name`, `undefined` when it holds none.
     */
    readonly kv: (name: string) => KvReader | undefined;
  }
>()("@workspace/config/WorkerBindings") {}

/**
 * The port `web` asks before it serves a request: a layer that provides it may refuse the request
 * with a response of its own. With no provider, nothing refuses.
 */
export class RequestGuard extends Context.Service<
  RequestGuard,
  {
    /**
     * The refusal for the request, else `undefined`. It never fails: a guard that cannot decide
     * serves.
     */
    readonly check: (request: Request) => Effect.Effect<Response | undefined>;
  }
>()("@workspace/config/RequestGuard") {}
