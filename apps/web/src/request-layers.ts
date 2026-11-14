import { Layer } from "effect";

/**
 * The layers `web`'s server entry builds once per isolate from the Worker's `env`, and whose
 * `RequestGuard` it asks about every request. Each entry reads plain bindings only, because `web`
 * has no Worker program in which Alchemy could register a binding. It is a file of its own, apart
 * from `blocks.ts`, so that the server entry does not import the layers that need such a binding.
 *
 * No block provides a layer here yet, so no `RequestGuard` refuses and `web` serves every request
 * the rate-limit check passes.
 */
export const WebRequestLayers = Layer.empty;
