import type { Rule } from "@oxlint/plugins";

/**
 * The media type of an RFC 9457 problem response.
 */
const PROBLEM_MEDIA_TYPE = "application/problem+json";

/**
 * Reports the problem media type written as a string literal: a problem response comes from
 * `ProblemDetails.toResponse` or a contract Problem class, which set the media type, the `type`
 * URI and the status together.
 */
const noHandBuiltProblem: Rule = {
  create(context) {
    return {
      Literal(node) {
        if (node.value === PROBLEM_MEDIA_TYPE) {
          context.report({ messageId: "noHandBuiltProblem", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow a hand-built problem response, so errors on the wire come from the contract Problem classes.",
    },
    messages: {
      noHandBuiltProblem:
        "Do not build a problem response by hand: return ProblemDetails.toResponse with a contract Problem class, which sets the media type, type URI and status together (docs/capabilities.md, Problem responses).",
    },
    schema: [],
    type: "problem",
  },
};

export default noHandBuiltProblem;
