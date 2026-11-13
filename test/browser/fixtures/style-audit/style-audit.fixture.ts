import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands } from "vite-plus/test/browser";
import type { BrowserCommands } from "vite-plus/test/internal/browser";
import { VIOLATIONS } from "./violations.ts";

/**
 * The part of the `audit` command's result this fixture reads. The command is in
 * `vite.browser.config.ts`, and is custom, so the typed `commands` object does not name it.
 */
interface AuditCommand {
  readonly audit: (
    target: string,
    cookie: string | undefined,
    colorScheme: "light" | "dark",
    inject: string | undefined,
  ) => Promise<{
    readonly findings: ReadonlyArray<{
      readonly element: string;
      readonly rule: string;
      readonly value: string;
    }>;
  }>;
}

const hasAudit = (candidate: BrowserCommands): candidate is BrowserCommands & AuditCommand =>
  "audit" in candidate;

const auditSeeded = Effect.fn("auditSeeded")(function* auditSeeded(
  colorScheme: "light" | "dark",
  inject: string,
) {
  if (!hasAudit(commands)) {
    return yield* Effect.die("The audit command is missing. Check vite.browser.config.ts.");
  }

  const auditor: AuditCommand = commands;

  return yield* Effect.promise(() => auditor.audit("/", undefined, colorScheme, inject));
});

/**
 * The seeded style violations. Their suffix is one no include of any config matches, so no run
 * picks them up unless a command names this file. Run explicitly, each fails once per theme, and
 * the message names the element and the value.
 */
describe("the seeded style violations", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const { html, name } of VIOLATIONS) {
      it.effect(`${name} passes the style audit in ${colorScheme}, which fails`, () =>
        Effect.gen(function* checkSeeded() {
          const { findings } = yield* auditSeeded(colorScheme, html);

          assert.deepStrictEqual(
            findings.map(({ element, rule, value }) => `${rule}: ${element}: ${value}`),
            [],
          );
        }),
      );
    }
  }
});
