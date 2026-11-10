import { expect, test } from "bun:test";
import noBuiltInTryCatch from "./no-built-in-try-catch.mjs";

/**
 * Collects diagnostics produced by one visit of the try/catch rule.
 *
 * @param {unknown} node Parsed try statement passed to the visitor.
 * @returns {{ messageId: string; node: unknown }[]} Diagnostics reported for that statement.
 */
const tryCatchReports = (node) => {
  /**
   * @type {{ messageId: string; node: unknown }[]}
   */
  const reports = [];

  const visitor = noBuiltInTryCatch.create({
    report(descriptor) {
      reports.push(descriptor);
    },
  });

  visitor.TryStatement(node);

  return reports;
};

test("reports a try statement that has a catch handler", () => {
  const node = { finalizer: { type: "BlockStatement" }, handler: { type: "CatchClause" } };

  expect(tryCatchReports(node)).toEqual([{ messageId: "noBuiltInTryCatch", node }]);
});

test("allows try/finally without a catch handler", () => {
  expect(tryCatchReports({ finalizer: { type: "BlockStatement" }, handler: undefined })).toEqual(
    [],
  );
  expect(tryCatchReports({ handler: null })).toEqual([]);
  expect(tryCatchReports({})).toEqual([]);
});

test("points the repair at an Effect error boundary", () => {
  expect(noBuiltInTryCatch.meta.messages.noBuiltInTryCatch).toBe(
    "Avoid built-in try/catch blocks: they can wrap multiple operations and hide which operation failed. Use Effect.try or Effect.tryPromise around the failing operation and handle its typed error.",
  );
});
