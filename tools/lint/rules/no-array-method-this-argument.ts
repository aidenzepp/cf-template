import type { ESTree, Rule } from "@oxlint/plugins";
import { Predicate } from "effect";

/*
 * Local copy of oxc's `unicorn/no-array-method-this-argument`, with `Effect` added to the ignored
 * callees so `Effect.forEach(xs, f, { concurrency })` is not read as a `thisArg`. Ported from
 * crates/oxc_linter/src/rules/unicorn/no_array_method_this_argument.rs at oxc commit
 * b7a1df3ef8c268a16adc502bb2388ca867c7c740 (helpers `is_method_call` in ast_util.rs and
 * `does_expr_match_any_path`). Delete this rule and turn unicorn's back on if oxc's `IGNORED` list
 * ever gains `Effect`.
 */

/**
 * The array prototype methods whose second argument is `thisArg` (oxc
 * `check_array_prototype_methods`).
 */
const prototypeMethods: ReadonlyArray<string> = [
  "every",
  "filter",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
];

/**
 * Callee paths that take a different second argument (oxc `IGNORED`), plus every
 * `Effect.<method>`: `Effect.forEach(xs, f, { concurrency })` takes options, not a `thisArg`.
 */
const ignored: ReadonlyArray<ReadonlyArray<string>> = [
  ["lodash", "every"],
  ["_", "every"],
  ["underscore", "every"],
  ["lodash", "filter"],
  ["_", "filter"],
  ["underscore", "filter"],
  ["Vue", "filter"],
  ["R", "filter"],
  ["lodash", "find"],
  ["_", "find"],
  ["underscore", "find"],
  ["R", "find"],
  ["lodash", "findLast"],
  ["_", "findLast"],
  ["underscore", "findLast"],
  ["R", "findLast"],
  ["lodash", "findIndex"],
  ["_", "findIndex"],
  ["underscore", "findIndex"],
  ["R", "findIndex"],
  ["lodash", "findLastIndex"],
  ["_", "findLastIndex"],
  ["underscore", "findLastIndex"],
  ["R", "findLastIndex"],
  ["lodash", "flatMap"],
  ["_", "flatMap"],
  ["lodash", "forEach"],
  ["_", "forEach"],
  ["React", "Children", "forEach"],
  ["Children", "forEach"],
  ["R", "forEach"],
  ["lodash", "map"],
  ["_", "map"],
  ["underscore", "map"],
  ["React", "Children", "map"],
  ["Children", "map"],
  ["jQuery", "map"],
  ["$", "map"],
  ["R", "map"],
  ["lodash", "some"],
  ["_", "some"],
  ...prototypeMethods.map((method) => ["Effect", method]),
];

/**
 * Strips wrappers that do not change the value (oxc `get_inner_expression`).
 */
const inner = (node: ESTree.Expression): ESTree.Expression => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    return inner(node.expression);
  }

  return node;
};

/**
 * The static property name of a member expression (oxc `static_property_name`); undefined when it
 * is dynamic or private.
 */
const staticName = (member: ESTree.MemberExpression): string | undefined => {
  const { property } = member;

  if (!member.computed) {
    return property.type === "Identifier" ? property.name : undefined;
  }

  if (property.type === "Literal" && Predicate.isString(property.value)) {
    return property.value;
  }

  if (property.type === "TemplateLiteral" && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
};

/**
 * The member expression a call goes through, if any (oxc `get_member_expr`).
 */
const calleeMember = (call: ESTree.CallExpression): ESTree.MemberExpression | undefined => {
  const callee = inner(call.callee);

  return callee.type === "MemberExpression" ? callee : undefined;
};

/**
 * Oxc `is_method_call`: argument-count bounds, an optional identifier-object list and an optional
 * method-name list.
 */
const isMethodCall = (
  call: ESTree.CallExpression,
  objects: ReadonlyArray<string> | undefined,
  methods: ReadonlyArray<string> | undefined,
  min: number | undefined,
  max: number | undefined,
): boolean => {
  const count = call.arguments.length;

  if ((min !== undefined && count < min) || (max !== undefined && count > max)) {
    return false;
  }

  const member = calleeMember(call);

  if (member === undefined) {
    return false;
  }

  if (objects !== undefined) {
    const object = inner(member.object);

    if (object.type !== "Identifier" || !objects.includes(object.name)) {
      return false;
    }
  }

  if (methods !== undefined) {
    const name = staticName(member);

    if (name === undefined || !methods.includes(name)) {
      return false;
    }
  }

  return true;
};

/**
 * Oxc `does_expr_match_any_path`: a chain of static member accesses on an identifier equal to an
 * ignored path.
 */
const isIgnored = (callee: ESTree.Expression): boolean => {
  const path: Array<string> = [];
  let current = callee;

  while (current.type === "MemberExpression") {
    if (current.computed || current.property.type !== "Identifier") {
      return false;
    }

    path.push(current.property.name);
    current = inner(current.object);
  }

  if (current.type !== "Identifier") {
    return false;
  }

  path.push(current.name);
  path.reverse();

  return ignored.some(
    (expected) =>
      expected.length === path.length &&
      expected.every((segment, index) => segment === path[index]),
  );
};

/**
 * Node types that are never a callback (oxc `is_node_not_function`), apart from literals,
 * `undefined` and calls, which `isNotFunction` checks.
 */
const neverFunction: ReadonlySet<string> = new Set([
  "ArrayExpression",
  "BinaryExpression",
  "ClassExpression",
  "TemplateLiteral",
  "UnaryExpression",
  "UpdateExpression",
  "AssignmentExpression",
  "AwaitExpression",
  "NewExpression",
  "TaggedTemplateExpression",
  "ThisExpression",
]);

/**
 * Oxc `is_node_not_function`: expressions that can never be a callback.
 */
const isNotFunction = (expression: ESTree.Expression): boolean => {
  if (neverFunction.has(expression.type)) {
    return true;
  }

  if (expression.type === "Literal") {
    return (
      expression.value === null ||
      Predicate.isString(expression.value) ||
      Predicate.isNumber(expression.value) ||
      "regex" in expression ||
      "bigint" in expression
    );
  }

  if (expression.type === "Identifier") {
    return expression.name === "undefined";
  }

  if (expression.type === "CallExpression") {
    return !isMethodCall(expression, undefined, ["bind"], undefined, undefined);
  }

  return false;
};

/**
 * A spread is not an expression, so oxc's `as_expression().is_none_or(..)` counts it as not a
 * function.
 */
const argumentIsNotFunction = (argument: ESTree.Argument): boolean =>
  argument.type === "SpreadElement" || isNotFunction(argument);

/**
 * Reports `thisArg` passed to the array iteration methods and to `Array.from`, except on `Effect`
 * and the other callees oxc ignores.
 */
const noArrayMethodThisArgument: Rule = {
  create(context) {
    return {
      CallExpression(node) {
        const [first, second, third] = node.arguments;

        if (
          first !== undefined &&
          second !== undefined &&
          !node.optional &&
          isMethodCall(node, undefined, prototypeMethods, 2, 2) &&
          !argumentIsNotFunction(first) &&
          second.type !== "SpreadElement" &&
          !isIgnored(node.callee)
        ) {
          context.report({ messageId: "noArrayMethodThisArgument", node: first });
        }

        const member = calleeMember(node);

        if (
          first !== undefined &&
          second !== undefined &&
          third !== undefined &&
          !node.optional &&
          member?.optional !== true &&
          isMethodCall(node, ["Array"], ["from", "fromAsync"], 3, 3) &&
          first.type !== "SpreadElement" &&
          third.type !== "SpreadElement" &&
          !argumentIsNotFunction(second)
        ) {
          context.report({ messageId: "noArrayMethodThisArgument", node: third });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow the `thisArg` parameter of array iteration methods such as `map`, `filter` and `some`.",
    },
    messages: {
      noArrayMethodThisArgument:
        "Avoid using 'thisArg' with array iteration methods. Use arrow functions or lexical scoping instead of passing 'thisArg' as a second argument to array methods like map, filter, etc.",
    },
    schema: [],
    type: "suggestion",
  },
};

export default noArrayMethodThisArgument;
