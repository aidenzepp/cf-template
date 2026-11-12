import type { ESTree, Rule } from "@oxlint/plugins";

/**
 * Reports an effect hook whose callback starts an Effect or calls the Better Auth client: server
 * data loads through a route loader or an atom, not from `useEffect`. React Doctor's fetch rules
 * see only a literal `fetch`; this closes the gap for `run(...)` and `authClient.*`.
 */
const noEffectDataLoad: Rule = {
  create(context) {
    const report = (node: ESTree.Node) => {
      context.report({ messageId: "noEffectDataLoad", node });
    };

    return {
      "CallExpression[callee.name=/^use(Layout)?Effect$/] CallExpression[callee.name=/^(run|runEffect|fork)$/]":
        report,
      'CallExpression[callee.name=/^use(Layout)?Effect$/] CallExpression[callee.object.name="authClient"]':
        report,
    };
  },
  meta: {
    docs: {
      description:
        "Disallow loading server data from a `useEffect` callback, so reads go through loaders and atoms.",
    },
    messages: {
      noEffectDataLoad:
        "Do not load server data from useEffect: read it in a route loader, an ApiClient.query atom or an authClient.use* atom, and refresh it with reactivityKeys (docs/capabilities.md, Server data, async UI and mutation state).",
    },
    schema: [],
    type: "problem",
  },
};

export default noEffectDataLoad;
