import { afterEach, describe, expect, it } from "@effect/vitest";
import { toast } from "sonner";
import { notify } from "./notify.ts";

afterEach(() => {
  toast.dismiss();
});

/**
 * The type, title and description of the toasts Sonner currently holds.
 */
const raised = () =>
  toast.getToasts().map((entry) => ({
    description: "description" in entry ? entry.description : undefined,
    title: "title" in entry ? entry.title : undefined,
    type: "type" in entry ? entry.type : undefined,
  }));

describe("notify", () => {
  it("raises each outcome with its own toast type", () => {
    notify.success("Saved");
    notify.error("Could not save");
    notify.info("Syncing");

    expect(raised().map(({ type }) => type)).toStrictEqual(["success", "error", "info"]);
  });

  it("carries the title and the optional description", () => {
    notify.error("Could not sign out", "Select Sign out again.");
    notify.info("Syncing");

    expect(raised()).toStrictEqual([
      { description: "Select Sign out again.", title: "Could not sign out", type: "error" },
      { description: undefined, title: "Syncing", type: "info" },
    ]);
  });
});
