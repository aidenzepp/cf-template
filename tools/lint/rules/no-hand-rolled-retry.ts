import type { Rule } from "@oxlint/plugins";

/**
 * A loop that counts attempts: a comparison against a name such as `attempt`, `retries` or `tries`.
 */
const counted =
  ":matches(WhileStatement, DoWhileStatement, ForStatement)" +
  ":has(BinaryExpression[operator=/^(<|<=|>|>=|===)$/]" +
  ":matches([left.name=/attempt|retr(y|ies)|tries/i], [right.name=/attempt|retr(y|ies)|tries/i]))";

/**
 * A loop that waits between attempts: a sleep, a timer or an await.
 */
const waits =
  ":has(:matches(CallExpression[callee.name=/^set(Timeout|Interval)$/], " +
  'CallExpression[callee.object.name="Effect"][callee.property.name="sleep"], AwaitExpression))';

/**
 * Reports a loop that waits and compares an attempt counter: that is `Effect.retry` with a
 * `Schedule`, which owns the delay, the limit and the interruption.
 */
const noHandRolledRetry: Rule = {
  create(context) {
    return {
      [`${counted}${waits}`](node) {
        context.report({ messageId: "noHandRolledRetry", node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow a loop that waits and counts attempts, so retries use `Effect.retry` with a `Schedule`.",
    },
    messages: {
      noHandRolledRetry:
        "Do not hand-roll a retry loop: use Effect.retry with a Schedule such as Schedule.exponential and Schedule.recurs (docs/capabilities.md, Retries).",
    },
    schema: [],
    type: "problem",
  },
};

export default noHandRolledRetry;
