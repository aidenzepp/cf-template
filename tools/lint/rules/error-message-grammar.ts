import type { ESTree, Rule } from "@oxlint/plugins";
import { Predicate } from "effect";

/**
 * Messages that say nothing on their own, compared lowercase with trailing punctuation removed.
 */
const vagueMessages = new Set([
  "an error occurred",
  "error",
  "failed",
  "something went wrong",
  "unknown error",
]);

/**
 * Cute or alarmed phrases that do not belong in an error message.
 */
const cutePhrases = ["oops", "uh oh", "whoops", "yikes"];

/**
 * Words that turn a message starting with "you" or "your" into blame.
 */
const blameWords = ["did", "entered", "failed", "forgot", "must", "provided"];

const blameOpener = new RegExp(`^(?:you|your)\\s+(?:${blameWords.join("|")})\\b`, "iu");

const emoji = /\p{Extended_Pictographic}/u;

/**
 * Whether the name of a class extended by `Schema.TaggedError` or `Data.TaggedError`.
 */
const isTaggedErrorBase = (node: ESTree.Node | null | undefined): boolean => {
  if (node?.type === "CallExpression") {
    const { callee } = node;

    return (
      (callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        (callee.object.name === "Schema" || callee.object.name === "Data") &&
        callee.property.type === "Identifier" &&
        callee.property.name === "TaggedError") ||
      isTaggedErrorBase(callee)
    );
  }

  return false;
};

/**
 * The literal text of a string or template literal, with each `${}` hole left empty.
 */
const literalText = (node: ESTree.Node): string | undefined => {
  if (node.type === "Literal" && Predicate.isString(node.value)) {
    return node.value;
  }

  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }

  return undefined;
};

/**
 * True when the whole message only forwards a cause: `String(x)`, `x.message`, `${x}` or
 * `x.toString()`.
 */
const forwardsCause = (node: ESTree.Node): boolean => {
  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 1 && literalText(node) === "";
  }

  if (node.type === "MemberExpression") {
    return (
      !node.computed && node.property.type === "Identifier" && node.property.name === "message"
    );
  }

  if (node.type !== "CallExpression") {
    return false;
  }

  const { callee } = node;

  return (
    (callee.type === "Identifier" && callee.name === "String" && node.arguments.length === 1) ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "toString" &&
      node.arguments.length === 0)
  );
};

/**
 * The message of `new X({ message })` or the first argument of `new Error(message)`.
 */
const messageValue = (node: ESTree.NewExpression): ESTree.Node | undefined => {
  const [first] = node.arguments;

  if (first?.type !== "ObjectExpression") {
    return node.callee.type === "Identifier" && node.callee.name === "Error" ? first : undefined;
  }

  return first.properties.find(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === "message") ||
        (property.key.type === "Literal" && property.key.value === "message")),
  )?.value;
};

/**
 * Reports an error message that is vague, cute, opens with blame or only forwards a cause. It
 * checks the `message` of `new X({ message })` for a class extending `Schema.TaggedError` or
 * `Data.TaggedError` declared in the file or named `*Error`, and the argument of `new Error(...)`.
 */
const errorMessageGrammar: Rule = {
  create(context) {
    const taggedClasses = new Set<string>();

    return {
      ClassDeclaration(node) {
        if (node.id !== null && isTaggedErrorBase(node.superClass)) {
          taggedClasses.add(node.id.name);
        }
      },
      NewExpression(node) {
        const { callee } = node;

        if (
          callee.type !== "Identifier" ||
          !(taggedClasses.has(callee.name) || callee.name.endsWith("Error"))
        ) {
          return;
        }

        const value = messageValue(node);

        if (value === undefined) {
          return;
        }

        const text = literalText(value);

        const report = (messageId: string) => {
          context.report({ messageId, node: value });
        };

        if (forwardsCause(value)) {
          report("forward");
        } else if (text !== undefined) {
          const lower = text.toLowerCase();

          if (vagueMessages.has(lower.replace(/[\s.!]+$/u, ""))) {
            report("vague");
          } else if (cutePhrases.some((phrase) => lower.includes(phrase)) || emoji.test(text)) {
            report("cute");
          } else if (blameOpener.test(text.trimStart())) {
            report("blame");
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow error messages that are vague, cute, open with blame, or only forward a cause.",
    },
    messages: {
      blame:
        "Do not open an error message by blaming the reader: say what was expected and what was received.",
      cute: "Keep the error message plain: drop the exclamation, emoji or playful phrase and say what failed.",
      forward:
        "Do not forward a cause as the whole message: say what operation failed and keep the cause in the `cause` field.",
      vague: "Do not use a vague error message: say what failed, why, and what to do next.",
    },
    schema: [],
    type: "problem",
  },
};

export default errorMessageGrammar;
