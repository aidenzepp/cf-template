import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { guardAlertName, guardReceiverAlert } from "./resources.ts";
import type { GuardPlanValue } from "./resources.ts";

const SPEC = { query: "SELECT 1", threshold: 5 };

const PLAN: GuardPlanValue = {
  alert: Option.some(SPEC),
  identity: { stack: "app", stage: "test-x" },
  receiver: { compatibility: { date: "2026-01-01", flags: [] }, name: "app-guard-receiver" },
};

describe("guardReceiverAlert", () => {
  it("binds the policy name the alert declares", () => {
    const { policy, props } = guardReceiverAlert(PLAN, SPEC);

    assert.strictEqual(policy, "app-guard-test-x");
    assert.strictEqual(policy, props.name);
    assert.strictEqual(policy, guardAlertName(PLAN));
  });
});
