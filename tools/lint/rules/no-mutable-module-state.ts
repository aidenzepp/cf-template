import type { ESTree, Rule, Scope } from "@oxlint/plugins";

/**
 * Methods that change the receiver in place on arrays, maps, sets and typed collections.
 */
const mutatingMethods = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

/**
 * Follows member accesses and TypeScript wrappers down to the identifier that owns the value, so
 * `state.items[0].name` and `state!.items` both resolve to `state`.
 */
const rootName = (node: ESTree.Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "MemberExpression") {
    return rootName(node.object);
  }

  if (
    node.type === "TSNonNullExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    return rootName(node.expression);
  }

  return undefined;
};

/**
 * Finds the scope that declares `name`, starting from the scope of the mutating node.
 */
const declaringScope = (scope: Scope | null, name: string): Scope | undefined => {
  if (scope === null) {
    return undefined;
  }

  return scope.set.has(name) ? scope : declaringScope(scope.upper, name);
};

/**
 * True when `name` is a variable declared at module scope. Imports are not state: `Ref.set` and
 * `Arr.sort` call functions on a module namespace.
 */
const isModuleVariable = (scope: Scope, name: string): boolean => {
  const owner = declaringScope(scope, name);

  return (
    owner !== undefined &&
    (owner.type === "module" || owner.type === "global") &&
    owner.set.get(name)?.defs.some((definition) => definition.type === "Variable") === true
  );
};

/**
 * Reports a mutation inside a function of a binding declared at module scope. Module-top-level
 * initialization is not reported, and a function-local binding that shadows the module one is not
 * the module binding.
 */
const noMutableModuleState: Rule = {
  create(context) {
    const check = (target: ESTree.Node, node: ESTree.Node) => {
      const name = rootName(target);

      const scope = context.sourceCode.getScope(node);

      const insideFunction =
        scope.variableScope.type !== "module" && scope.variableScope.type !== "global";

      if (name !== undefined && insideFunction && isModuleVariable(scope, name)) {
        context.report({ messageId: "noMutableModuleState", node });
      }
    };

    return {
      AssignmentExpression(node) {
        check(node.left, node);
      },
      CallExpression(node) {
        const { callee } = node;

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          mutatingMethods.has(callee.property.name)
        ) {
          check(callee.object, node);
        }
      },
      UpdateExpression(node) {
        check(node.argument, node);
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow mutating module-level state from inside a function, so state lives in Effect services and Refs rather than in isolate-wide variables.",
    },
    messages: {
      noMutableModuleState:
        "Do not mutate module-level state inside a function: keep the state in an Effect service, Ref or Layer, or build it at module top level.",
    },
    schema: [],
    type: "problem",
  },
};

export default noMutableModuleState;
