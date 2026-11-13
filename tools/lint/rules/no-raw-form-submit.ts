import type { Rule } from "@oxlint/plugins";

/**
 * Reports a `<form onSubmit>` and a `new FormData`: forms go through the TanStack Form hook in
 * `components/form`, which owns submission and field values (`docs/capabilities.md`, Forms).
 */
const noRawFormSubmit: Rule = {
  create(context) {
    return {
      'JSXOpeningElement[name.name="form"] > JSXAttribute[name.name=/^onSubmit(Capture)?$/]'(node) {
        context.report({ messageId: "noRawFormSubmit", node });
      },
      'NewExpression[callee.name="FormData"]'(node) {
        context.report({ messageId: "noRawFormSubmit", node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow `<form onSubmit>` and `new FormData`, so every form submits through the TanStack Form hook.",
    },
    messages: {
      noRawFormSubmit:
        "Do not submit a form with onSubmit or read it with FormData: build it with the TanStack Form hook in components/form and call form.handleSubmit (docs/capabilities.md, Forms).",
    },
    schema: [],
    type: "problem",
  },
};

export default noRawFormSubmit;
