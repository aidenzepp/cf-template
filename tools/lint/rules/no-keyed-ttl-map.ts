import type { Rule } from "@oxlint/plugins";

/**
 * A function that reads the clock: `Clock.currentTimeMillis` or `Date.now()`.
 */
const readsClock =
  ":function:has(:matches(" +
  'MemberExpression[object.name="Clock"][property.name="currentTimeMillis"], ' +
  'CallExpression[callee.object.name="Date"][callee.property.name="now"]))';

/**
 * Reports a `Map` built in a function that also reads the clock: a map of timestamped entries is a
 * hand-built TTL cache, and `Cache.make` or `Effect.cachedWithTTL` owns expiry, capacity and
 * concurrent lookups.
 */
const noKeyedTtlMap: Rule = {
  create(context) {
    return {
      [`${readsClock} NewExpression[callee.name="Map"]`](node) {
        context.report({ messageId: "noKeyedTtlMap", node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow a `Map` next to a clock read, so time-limited caches use `Cache` or `Effect.cachedWithTTL`.",
    },
    messages: {
      noKeyedTtlMap:
        "Do not keep a TTL cache in a Map beside the clock: use Cache.make or Cache.makeWith for keyed entries, or Effect.cachedWithTTL for one value (docs/capabilities.md, Caching).",
    },
    schema: [],
    type: "problem",
  },
};

export default noKeyedTtlMap;
