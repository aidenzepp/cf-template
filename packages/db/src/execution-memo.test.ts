import { describe, expect, it } from "@effect/vitest";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";

// Alchemy documents no page for this subpath; an Alchemy bump that moves it fails here, not in a deploy.
describe("alchemy/Runtime/ExecutionMemo", () => {
  it("resolves makeExecutionMemo at the pinned Alchemy version", () => {
    expect(makeExecutionMemo).toBeTypeOf("function");
  });
});
