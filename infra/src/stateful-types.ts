import { Schema } from "effect";

/**
 * The one list of stateful resource types (C41e): the types whose `replace`, `delete` or
 * `orphaned` in a `prod` plan loses data, so the plan classifier holds the deploy. The retain test
 * reads the same list. A block that declares another stateful type (a Durable Object namespace,
 * for one) adds it here as part of its acceptance; nothing else extends it.
 */
const StatefulType = Schema.Literals([
  "Cloudflare.D1Database",
  "Cloudflare.KV.Namespace",
  "Cloudflare.R2.Bucket",
  "Cloudflare.Queues.Queue",
  "Cloudflare.SecretsStore",
  "Cloudflare.SecretsStore.Secret",
  // Pre-rename types (each provider's `aliases`): state persisted under an old name still plans under it.
  "Cloudflare.KVNamespace",
  "Cloudflare.R2Bucket",
  "Cloudflare.Queue",
]);

/**
 * Whether a planned resource's `resourceType` is on the stateful list.
 *
 * @param resourceType - The `resourceType` of a planned resource row.
 * @returns True for a listed type.
 */
export const isStatefulType = Schema.is(StatefulType);
