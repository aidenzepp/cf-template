import type { Rule } from "@oxlint/plugins";

/**
 * Reports an effect hook that reads `AsyncResult.isSuccess` or `AsyncResult.isFailure`: reacting to
 * a finished call by watching its result in an effect runs the follow-up a render late and twice
 * under StrictMode. A mutation refreshes what it changed through `reactivityKeys`.
 */
const noEffectOnAsyncResult: Rule = {
  create(context) {
    return {
      'CallExpression[callee.name=/^use(Layout)?Effect$/] MemberExpression[object.name="AsyncResult"][property.name=/^is(Success|Failure)$/]'(
        node,
      ) {
        context.report({ messageId: "noEffectOnAsyncResult", node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow reacting to an `AsyncResult` in `useEffect`, so a finished mutation refreshes through `reactivityKeys`.",
    },
    messages: {
      noEffectOnAsyncResult:
        'Do not react to a finished call in useEffect: declare reactivityKeys on the ApiClient.mutation, or run the follow-up in the handler with useAtomSet(atom, { mode: "promise" }) (docs/capabilities.md, Server data, async UI and mutation state).',
    },
    schema: [],
    type: "problem",
  },
};

export default noEffectOnAsyncResult;
